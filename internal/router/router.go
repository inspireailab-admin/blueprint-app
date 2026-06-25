// Package router implements the small-first / escalate-on-uncertainty
// model routing pattern: every prompt first hits a small (cheap) model;
// if the small model's response triggers an escalation rule, the
// prompt is replayed against a large (expensive) model and the larger
// answer wins.
//
// Heuristic in v1 is content-based â€” the small model's response is
// matched against configured patterns ("I don't know", "I'm not
// sure", etc.). Patterns are case-insensitive substrings. This is
// crude but practical: small models tend to bail out explicitly
// rather than hallucinate when over their head, and a substring
// match catches that.
//
// State is persisted to ~/.blueprint/router.json. Stats track lifetime
// route distribution + escalation rate so the Dashboard can render
// cost savings.

package router

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"
)

// Endpoint describes one LLM behind an OpenAI-compatible API.
type Endpoint struct {
	Label   string `json:"label"`   // human label, "Llama 3.2 1B" / "Anthropic Sonnet 4.6"
	BaseURL string `json:"baseUrl"` // e.g. "http://127.0.0.1:8080/v1" or "https://api.anthropic.com/v1"
	APIKey  string `json:"apiKey"`  // bearer token
	Model   string `json:"model"`   // model identifier the API expects ("local", "claude-sonnet-4-6", â€¦)
}

// Config is what the user tunes from the Dashboard. Both endpoints
// must be set for the router to operate; either being empty means
// "fall back to direct calls."
type Config struct {
	Enabled bool `json:"enabled"`

	Small Endpoint `json:"small"`
	Large Endpoint `json:"large"`

	// EscalationPatterns are case-insensitive substrings. If ANY
	// pattern is present in the small model's response, the request
	// re-runs against the Large endpoint and the larger response is
	// what the caller sees.
	EscalationPatterns []string `json:"escalationPatterns"`

	// AlwaysEscalateOnPrefix â€” prompts beginning with any of these
	// strings skip the small model entirely. Useful for tasks the
	// user knows in advance need the bigger model (e.g. "Summarize:",
	// "Translate:").
	AlwaysEscalateOnPrefix []string `json:"alwaysEscalateOnPrefix"`
}

// Decision is what the router returns to its caller. Source tells the
// UI which endpoint actually served the response so the Dashboard can
// label routes correctly.
type Decision struct {
	Source         string `json:"source"` // "small" | "large"
	Escalated      bool   `json:"escalated"`
	Reason         string `json:"reason,omitempty"` // pattern that triggered escalation, or "prefix-rule" / "small-empty"
	SmallResponse  string `json:"smallResponse,omitempty"`
}

// Stats reports route distribution and lets the Dashboard render the
// "we saved X% of calls vs. always-large" story.
type Stats struct {
	Enabled         bool    `json:"enabled"`
	SmallOnly       int64   `json:"smallOnly"`
	Escalated       int64   `json:"escalated"`
	PrefixSkipped   int64   `json:"prefixSkipped"`
	TotalCalls      int64   `json:"totalCalls"`
	EscalationRatio float64 `json:"escalationRatio"`
}

// DefaultConfig is a fresh install's starting point. Disabled by
// default so the user opts in deliberately; pre-populates the
// escalation patterns with common bail-out phrases so the demo
// works without further tuning.
var DefaultConfig = Config{
	Enabled: false,
	Small:   Endpoint{Label: "Small model", BaseURL: "http://127.0.0.1:8080/v1", APIKey: "blueprint-local", Model: "local"},
	Large:   Endpoint{Label: "Large model", BaseURL: "http://127.0.0.1:8080/v1", APIKey: "blueprint-local", Model: "local"},
	EscalationPatterns: []string{
		"I don't know",
		"I'm not sure",
		"I do not have",
		"I cannot",
		"I am unable",
		"I don't have enough",
		"sorry, I can't",
	},
	AlwaysEscalateOnPrefix: []string{},
}

// Router holds the persisted config + counters. Safe for concurrent use.
type Router struct {
	mu     sync.Mutex
	config Config
	stats  Stats
	dirty  bool
}

// New loads from disk, returns an empty Router on error. Cache-style
// state â€” non-load-bearing.
func New() *Router {
	r := &Router{config: DefaultConfig}
	r.load()
	return r
}

// Config snapshots the current settings.
func (r *Router) Config() Config {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.config
}

// SetConfig persists new settings.
func (r *Router) SetConfig(cfg Config) {
	r.mu.Lock()
	r.config = sanitize(cfg)
	r.dirty = true
	r.mu.Unlock()
	r.save()
}

// Stats snapshots counters.
func (r *Router) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.stats
	s.Enabled = r.config.Enabled
	s.TotalCalls = s.SmallOnly + s.Escalated + s.PrefixSkipped
	if s.TotalCalls > 0 {
		s.EscalationRatio = float64(s.Escalated+s.PrefixSkipped) / float64(s.TotalCalls)
	}
	return s
}

// â”€â”€â”€ Routing decisions (no I/O â€” caller handles the HTTP) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// ShouldSkipToLarge returns true when the prompt prefix matches an
// always-escalate rule. The caller skips the small-model call entirely.
func (r *Router) ShouldSkipToLarge(prompt string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.config.AlwaysEscalateOnPrefix {
		if p != "" && strings.HasPrefix(prompt, p) {
			return true
		}
	}
	return false
}

// ShouldEscalate checks the small model's response against the
// escalation patterns + returns the matching pattern (or "" if no
// escalation needed).
func (r *Router) ShouldEscalate(response string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if response == "" {
		return "small-empty"
	}
	low := strings.ToLower(response)
	for _, p := range r.config.EscalationPatterns {
		if p == "" {
			continue
		}
		if strings.Contains(low, strings.ToLower(p)) {
			return p
		}
	}
	return ""
}

// RecordSmallOnly bumps the "small handled it" counter.
func (r *Router) RecordSmallOnly() {
	r.mu.Lock()
	r.stats.SmallOnly++
	r.dirty = true
	r.mu.Unlock()
	r.save()
}

// RecordEscalated bumps the "small bailed, large served" counter.
func (r *Router) RecordEscalated() {
	r.mu.Lock()
	r.stats.Escalated++
	r.dirty = true
	r.mu.Unlock()
	r.save()
}

// RecordPrefixSkipped bumps the "prefix rule skipped the small model" counter.
func (r *Router) RecordPrefixSkipped() {
	r.mu.Lock()
	r.stats.PrefixSkipped++
	r.dirty = true
	r.mu.Unlock()
	r.save()
}

// ResetStats zeros the counters. Settings survive.
func (r *Router) ResetStats() {
	r.mu.Lock()
	r.stats = Stats{}
	r.dirty = true
	r.mu.Unlock()
	r.save()
}

// â”€â”€â”€ Persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type persisted struct {
	Config Config `json:"config"`
	Stats  Stats  `json:"stats"`
}

func cfgPath() (string, error) {
	root, err := paths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "router.json"), nil
}

func (r *Router) load() {
	path, err := cfgPath()
	if err != nil {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var p persisted
	if json.Unmarshal(b, &p) != nil {
		return
	}
	r.config = sanitize(p.Config)
	r.stats = p.Stats
}

func (r *Router) save() {
	r.mu.Lock()
	if !r.dirty {
		r.mu.Unlock()
		return
	}
	out := persisted{Config: r.config, Stats: r.stats}
	r.dirty = false
	r.mu.Unlock()
	path, err := cfgPath()
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

func sanitize(c Config) Config {
	if c.Small.Model == "" {
		c.Small.Model = "local"
	}
	if c.Large.Model == "" {
		c.Large.Model = "local"
	}
	if len(c.EscalationPatterns) == 0 && !c.Enabled {
		c.EscalationPatterns = DefaultConfig.EscalationPatterns
	}
	// Drop empty pattern strings so the matching loop doesn't trip.
	patterns := c.EscalationPatterns[:0]
	for _, p := range c.EscalationPatterns {
		if strings.TrimSpace(p) != "" {
			patterns = append(patterns, p)
		}
	}
	c.EscalationPatterns = patterns
	prefixes := c.AlwaysEscalateOnPrefix[:0]
	for _, p := range c.AlwaysEscalateOnPrefix {
		if strings.TrimSpace(p) != "" {
			prefixes = append(prefixes, p)
		}
	}
	c.AlwaysEscalateOnPrefix = prefixes
	return c
}
