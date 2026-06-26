// Package hosts is the persisted registry of remote machines this
// Blueprint instance can deploy to and manage over SSH.
//
// Distinct from internal/remotes:
//   - remotes = OpenAI-compatible HTTP endpoints we READ from (probe
//     /health, /v1/models, /metrics) — they're already up and
//     someone else manages them.
//   - hosts   = Linux/macOS machines we OWN end-to-end. We install
//     Blueprint on them via SSH, manage their lifecycle, and reach
//     their svc control plane over an SSH tunnel.
//
// State lives at ~/.blueprint/hosts.json — a small file, one JSON
// object per host in a flat list. Private SSH key material never
// goes here; we only store the path to the user's key file (same
// model as ~/.ssh/config).

package hosts

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

// Role is a free-text label, but the Dashboard treats certain values
// specially (e.g. "prod" gets a warning before destructive ops).
type Role string

const (
	RoleDev    Role = "dev"
	RoleShared Role = "shared"
	RoleProd   Role = "prod"
)

// Provenance distinguishes hosts the user pre-owned (BYO) from hosts
// Blueprint provisioned via a cloud provider API. Phase B only has
// BYO; Phase C adds the cloud-provisioned kind.
type Provenance string

const (
	ProvenanceBYO   Provenance = "byo"
	ProvenanceCloud Provenance = "cloud"
)

// Host is one registered SSH target.
type Host struct {
	// ID is a stable random identifier. Lets us reorder + edit without
	// the UI fighting itself.
	ID string `json:"id"`

	// Label is what the user sees on the card. Free text.
	Label string `json:"label"`

	// User is the SSH login, e.g. "root", "ubuntu", "ec2-user".
	User string `json:"user"`

	// Host is the hostname or IP, e.g. "10.0.1.42", "gpu-1.client.com".
	Host string `json:"host"`

	// Port is the SSH port. Zero defaults to 22 at connect time.
	Port int `json:"port,omitempty"`

	// KeyPath is the path to the private SSH key file (e.g.
	// ~/.ssh/id_ed25519). The key never gets read into this struct;
	// the SSH client reads it at connect time. Empty means use the
	// agent (SSH_AUTH_SOCK) or the default key set on this machine.
	KeyPath string `json:"keyPath,omitempty"`

	// Role is "dev" | "shared" | "prod" — used for guardrails on
	// destructive actions and as a visual badge in the sidebar.
	Role Role `json:"role"`

	// Provenance is "byo" for hosts the user owns or "cloud" for
	// hosts Blueprint provisioned on a cloud provider. Phase B only
	// emits BYO; cloud comes later.
	Provenance Provenance `json:"provenance"`

	// LastSeenAtMs is when we last successfully reached the host's
	// control plane (or any SSH session). Zero means never.
	LastSeenAtMs int64 `json:"lastSeenAtMs,omitempty"`

	// AddedAtMs is when the user created this entry.
	AddedAtMs int64 `json:"addedAtMs"`
}

// Registry holds the list. Persisted-via-debounce, similar to
// internal/remotes.
type Registry struct {
	mu    sync.Mutex
	hosts []Host
	dirty bool
}

// New loads from disk. Missing file → empty registry. Malformed file
// → empty (we don't want a stale write to crash the app).
func New() *Registry {
	r := &Registry{}
	r.load()
	return r
}

// List returns a copy of the hosts ordered by AddedAtMs ascending.
func (r *Registry) List() []Host {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Host, len(r.hosts))
	copy(out, r.hosts)
	sort.Slice(out, func(i, j int) bool { return out[i].AddedAtMs < out[j].AddedAtMs })
	return out
}

// Add inserts a new host with a freshly-allocated ID. Returns the
// created entry so the UI can refresh its list with the canonical
// version.
func (r *Registry) Add(in Host) (Host, error) {
	if strings.TrimSpace(in.Label) == "" {
		return Host{}, fmt.Errorf("label is required")
	}
	if strings.TrimSpace(in.Host) == "" {
		return Host{}, fmt.Errorf("host is required")
	}
	if strings.TrimSpace(in.User) == "" {
		return Host{}, fmt.Errorf("user is required")
	}
	in.ID = randID()
	in.AddedAtMs = time.Now().UnixMilli()
	if in.Role == "" {
		in.Role = RoleDev
	}
	if in.Provenance == "" {
		in.Provenance = ProvenanceBYO
	}
	r.mu.Lock()
	r.hosts = append(r.hosts, in)
	r.dirty = true
	r.mu.Unlock()
	r.save()
	return in, nil
}

// Update replaces the entry with the matching ID. Errors if not found.
func (r *Registry) Update(in Host) error {
	r.mu.Lock()
	for i, existing := range r.hosts {
		if existing.ID == in.ID {
			in.AddedAtMs = existing.AddedAtMs       // preserve creation time
			in.LastSeenAtMs = existing.LastSeenAtMs // never overwrite via Update
			r.hosts[i] = in
			r.dirty = true
			r.mu.Unlock()
			r.save()
			return nil
		}
	}
	r.mu.Unlock()
	return fmt.Errorf("host %q not found", in.ID)
}

// Remove drops the entry. Idempotent — missing ID returns nil.
func (r *Registry) Remove(id string) error {
	r.mu.Lock()
	kept := r.hosts[:0]
	for _, x := range r.hosts {
		if x.ID != id {
			kept = append(kept, x)
		}
	}
	r.hosts = kept
	r.dirty = true
	r.mu.Unlock()
	r.save()
	return nil
}

// Get returns the entry with the given ID or empty + ok=false.
func (r *Registry) Get(id string) (Host, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.hosts {
		if x.ID == id {
			return x, true
		}
	}
	return Host{}, false
}

// TouchSeen updates LastSeenAtMs for the given host. Called by the
// SSH connection layer (Phase B.2+) on a successful connection.
func (r *Registry) TouchSeen(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, x := range r.hosts {
		if x.ID == id {
			r.hosts[i].LastSeenAtMs = time.Now().UnixMilli()
			r.dirty = true
			break
		}
	}
	go r.save()
}

// ─── Persistence ────────────────────────────────────────────────────

func storagePath() (string, error) {
	root, err := paths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "hosts.json"), nil
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
		Hosts []Host `json:"hosts"`
	}
	if json.Unmarshal(b, &raw) != nil {
		return
	}
	r.hosts = raw.Hosts
}

func (r *Registry) save() {
	r.mu.Lock()
	if !r.dirty {
		r.mu.Unlock()
		return
	}
	out := struct {
		Hosts []Host `json:"hosts"`
	}{Hosts: r.hosts}
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
