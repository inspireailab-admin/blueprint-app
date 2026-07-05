// Package fleet is the persisted registry of remote machines enrolled via the
// relay (docs/plan-target-aware-deploy.md §4/§5).
//
// Distinct from internal/hosts (SSH-managed) and internal/remotes (monitor-only
// endpoints): a fleet machine ran our installer and paired through the relay, so
// we reach it over an E2E-encrypted control channel — no SSH, no inbound ports.
//
// State lives at ~/.blueprint/fleet.json. No secrets here: the per-machine
// reconnect secret is stored in the OS keychain (like the svc token), not in
// this file.
package fleet

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/agent"
	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"
)

// Machine is one enrolled remote target.
type Machine struct {
	// ID is a stable random identifier used by the UI and to key live
	// connections.
	ID string `json:"id"`
	// Label is what the user sees. Free text.
	Label string `json:"label"`
	// Hardware is the profile detected at enrollment (refreshed on reconnect).
	Hardware agent.Hardware `json:"hardware"`
	// ReconnectToken is the stable relay routing token for durable
	// reconnection (the auth secret lives in the keychain, not here).
	ReconnectToken string `json:"reconnectToken,omitempty"`
	EnrolledAtMs   int64  `json:"enrolledAtMs"`
	LastSeenAtMs   int64  `json:"lastSeenAtMs,omitempty"`
}

// Registry holds the enrolled machines, persisted to disk.
type Registry struct {
	mu       sync.Mutex
	machines []Machine
	dirty    bool
}

// New loads from disk; a missing or malformed file yields an empty registry.
func New() *Registry {
	r := &Registry{}
	r.load()
	return r
}

// List returns a copy ordered by enrollment time.
func (r *Registry) List() []Machine {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Machine, len(r.machines))
	copy(out, r.machines)
	sort.Slice(out, func(i, j int) bool { return out[i].EnrolledAtMs < out[j].EnrolledAtMs })
	return out
}

// Add inserts a machine with a fresh ID (unless one is supplied) and returns it.
func (r *Registry) Add(in Machine) (Machine, error) {
	if strings.TrimSpace(in.Label) == "" {
		in.Label = "Unnamed machine"
	}
	if in.ID == "" {
		in.ID = randID()
	}
	in.EnrolledAtMs = time.Now().UnixMilli()
	in.LastSeenAtMs = in.EnrolledAtMs
	r.mu.Lock()
	r.machines = append(r.machines, in)
	r.dirty = true
	r.mu.Unlock()
	r.save()
	return in, nil
}

// Get returns the machine with the given ID.
func (r *Registry) Get(id string) (Machine, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, m := range r.machines {
		if m.ID == id {
			return m, true
		}
	}
	return Machine{}, false
}

// Remove drops a machine. Idempotent.
func (r *Registry) Remove(id string) error {
	r.mu.Lock()
	kept := r.machines[:0]
	for _, m := range r.machines {
		if m.ID != id {
			kept = append(kept, m)
		}
	}
	r.machines = kept
	r.dirty = true
	r.mu.Unlock()
	r.save()
	return nil
}

// UpdateHardware refreshes a machine's hardware profile + last-seen time.
func (r *Registry) UpdateHardware(id string, hw agent.Hardware) {
	r.mu.Lock()
	for i, m := range r.machines {
		if m.ID == id {
			r.machines[i].Hardware = hw
			r.machines[i].LastSeenAtMs = time.Now().UnixMilli()
			r.dirty = true
			break
		}
	}
	r.mu.Unlock()
	r.save()
}

// TouchSeen updates LastSeenAtMs.
func (r *Registry) TouchSeen(id string) {
	r.mu.Lock()
	for i, m := range r.machines {
		if m.ID == id {
			r.machines[i].LastSeenAtMs = time.Now().UnixMilli()
			r.dirty = true
			break
		}
	}
	r.mu.Unlock()
	r.save()
}

// ─── Persistence ────────────────────────────────────────────────────────────

func storagePath() (string, error) {
	root, err := paths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "fleet.json"), nil
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
		Machines []Machine `json:"machines"`
	}
	if json.Unmarshal(b, &raw) != nil {
		return
	}
	r.machines = raw.Machines
}

func (r *Registry) save() {
	r.mu.Lock()
	if !r.dirty {
		r.mu.Unlock()
		return
	}
	out := struct {
		Machines []Machine `json:"machines"`
	}{Machines: r.machines}
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

func randID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("m%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}
