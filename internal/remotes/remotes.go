// Package remotes is the persisted registry of remote OpenAI-compatible
// LLM endpoints the Dashboard monitors alongside the local service.
//
// One Blueprint instance can keep an eye on llama-server / vLLM /
// TensorRT-LLM / vendor APIs running anywhere reachable on HTTP. Each
// remote is just a label + URL + API key + optional model identifier;
// the Dashboard probes /health, /v1/models, and (when scrape-able)
// /metrics for each entry.
//
// State lives at ~/.blueprint/remotes.json — a small file, one JSON
// object per remote in a flat list. We never include API keys in
// logs or events.
//
// Author: Amar Mond.
package remotes

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"
)

// Remote is one registered endpoint.
type Remote struct {
	// ID is a stable random identifier. Lets us reorder + edit without
	// the UI fighting itself.
	ID string `json:"id"`

	// Label is what the user sees on the card. Free text.
	Label string `json:"label"`

	// BaseURL is the OpenAI-compatible root, e.g.
	//   http://10.0.1.42:8080/v1
	//   https://api.openai.com/v1
	BaseURL string `json:"baseUrl"`

	// APIKey is the bearer token. Stored in plaintext on disk — same
	// trust model as ~/.aws/credentials. Empty for endpoints that
	// don't require auth.
	APIKey string `json:"apiKey"`

	// Model is the identifier the server expects when we ask for a
	// chat completion — "local" for llama-server, "claude-sonnet-4-6"
	// for Anthropic, etc.
	Model string `json:"model"`

	// Kind helps the Dashboard pick the right probe shape. One of:
	// "llamacpp" | "vllm" | "vendor". Default = "llamacpp".
	Kind string `json:"kind,omitempty"`

	// AddedAtMs is when the user created this entry.
	AddedAtMs int64 `json:"addedAtMs"`
}

// Registry holds the list. Persisted-via-debounce, similar to
// internal/router.
type Registry struct {
	mu      sync.Mutex
	remotes []Remote
	dirty   bool
}

// New loads from disk. Missing file → empty registry. Malformed file
// → empty (we don't want a stale write to crash the app).
func New() *Registry {
	r := &Registry{}
	r.load()
	return r
}

// List returns a copy of the remotes ordered by AddedAtMs ascending.
func (r *Registry) List() []Remote {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Remote, len(r.remotes))
	copy(out, r.remotes)
	sort.Slice(out, func(i, j int) bool { return out[i].AddedAtMs < out[j].AddedAtMs })
	return out
}

// Add inserts a new remote with a freshly-allocated ID. Returns the
// created entry so the UI can refresh its list with the canonical
// version.
func (r *Registry) Add(in Remote) (Remote, error) {
	if strings.TrimSpace(in.Label) == "" {
		return Remote{}, fmt.Errorf("label is required")
	}
	if strings.TrimSpace(in.BaseURL) == "" {
		return Remote{}, fmt.Errorf("baseUrl is required")
	}
	in.ID = randID()
	in.AddedAtMs = time.Now().UnixMilli()
	if in.Kind == "" {
		in.Kind = "llamacpp"
	}
	if in.Model == "" {
		in.Model = "local"
	}
	r.mu.Lock()
	r.remotes = append(r.remotes, in)
	r.dirty = true
	r.mu.Unlock()
	r.save()
	return in, nil
}

// Update replaces the entry with the matching ID. Errors if not found.
func (r *Registry) Update(in Remote) error {
	r.mu.Lock()
	for i, existing := range r.remotes {
		if existing.ID == in.ID {
			in.AddedAtMs = existing.AddedAtMs // preserve creation time
			r.remotes[i] = in
			r.dirty = true
			r.mu.Unlock()
			r.save()
			return nil
		}
	}
	r.mu.Unlock()
	return fmt.Errorf("remote %q not found", in.ID)
}

// Remove drops the entry. Idempotent — missing ID returns nil.
func (r *Registry) Remove(id string) error {
	r.mu.Lock()
	kept := r.remotes[:0]
	for _, x := range r.remotes {
		if x.ID != id {
			kept = append(kept, x)
		}
	}
	r.remotes = kept
	r.dirty = true
	r.mu.Unlock()
	r.save()
	return nil
}

// Get returns the entry with the given ID or nil + ok=false.
func (r *Registry) Get(id string) (Remote, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.remotes {
		if x.ID == id {
			return x, true
		}
	}
	return Remote{}, false
}

// ─── Persistence ──────────────────────────────────────────────────────────

func storagePath() (string, error) {
	root, err := paths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "remotes.json"), nil
}

func (r *Registry) load() {
	path, err := storagePath()
	if err != nil {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var raw struct {
		Remotes []Remote `json:"remotes"`
	}
	if json.Unmarshal(b, &raw) != nil {
		return
	}
	r.remotes = raw.Remotes
}

func (r *Registry) save() {
	r.mu.Lock()
	if !r.dirty {
		r.mu.Unlock()
		return
	}
	out := struct {
		Remotes []Remote `json:"remotes"`
	}{Remotes: r.remotes}
	r.dirty = false
	r.mu.Unlock()
	path, err := storagePath()
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, b, 0o644)
}

// randID returns a 12-character lowercase alphanumeric ID. Enough
// entropy for a desktop registry; we'll never hit collisions.
func randID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	out := make([]byte, 12)
	now := time.Now().UnixNano()
	for i := range out {
		out[i] = alphabet[uint64(now)%uint64(len(alphabet))]
		now /= int64(len(alphabet))
		if now == 0 {
			now = time.Now().UnixNano()
		}
	}
	return string(out)
}
