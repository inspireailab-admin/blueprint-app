// Package promptcache caches LLM responses keyed by semantic similarity
// of the prompt. The point: when a user (or their app) asks the same
// thing in slightly different wording — "summarize the contract"
// vs "give me a summary of the contract" — we return the cached
// answer instead of round-tripping to llama-server.
//
// Implementation choices for the v1 here:
//
//   - In-memory map persisted to a single JSON file at
//     ~/.blueprint/promptcache.json. Loads on first use, autosaves on
//     a debounced write loop. SQLite would scale better but a single
//     desktop user with ~100-1000 cached prompts fits in 200 KB of
//     JSON comfortably.
//
//   - Similarity = cosine of token-frequency vectors. Not as good as
//     real embeddings, but ships without a separate model dependency
//     and catches the common case of "same question reworded
//     slightly." Upgrade path: swap in real embeddings later via the
//     same Lookup/Store interface, no caller changes.
//
//   - TTL is enforced on Lookup (entry past TTL returns miss + is
//     deleted). Max-size eviction is LRU on Lookup time.
//
//   - Stats track hits, misses, hit ratio, total entries, total bytes.

package promptcache

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/inspireailab-admin/blueprint/pkg/paths"
)

// Config is what the user can tune from the Dashboard. Persisted in the
// same JSON file alongside the entries (under "_config").
type Config struct {
	// Enabled flips the whole cache. When false, Lookup always misses
	// and Store is a no-op — equivalent to no caching at all.
	Enabled bool `json:"enabled"`

	// Threshold is the minimum cosine similarity to count as a hit.
	// Range 0..1. 0.95 = "essentially identical phrasing", 0.85 =
	// "same intent, different wording". 0.95 is the safe default.
	Threshold float64 `json:"threshold"`

	// TTLSeconds drops entries older than this on Lookup. 0 = no TTL.
	// 24h (86400) is a sensible default for chat workloads.
	TTLSeconds int64 `json:"ttlSeconds"`

	// MaxEntries caps the cache. LRU eviction by last access time.
	// 0 = unbounded.
	MaxEntries int `json:"maxEntries"`
}

// DefaultConfig is what a fresh install gets. Conservative: cache
// disabled by default — the user opts in from the Dashboard once they
// understand the trade-off (cache hits return potentially stale
// content for the same prompt).
var DefaultConfig = Config{
	Enabled:    false,
	Threshold:  0.95,
	TTLSeconds: 86400, // 24h
	MaxEntries: 500,
}

// Entry is one cached prompt → response pair. The Tokens field is the
// pre-tokenized form of the prompt, kept so similarity scoring doesn't
// re-tokenize on every lookup.
type Entry struct {
	Prompt       string    `json:"prompt"`
	Response     string    `json:"response"`
	Tokens       []string  `json:"tokens"`
	CreatedAtMs  int64     `json:"createdAtMs"`
	LastUsedAtMs int64     `json:"lastUsedAtMs"`
	Hits         int       `json:"hits"`
}

// Stats reports cache health for the Dashboard surface.
type Stats struct {
	Enabled  bool    `json:"enabled"`
	Entries  int     `json:"entries"`
	Hits     int64   `json:"hits"`
	Misses   int64   `json:"misses"`
	HitRatio float64 `json:"hitRatio"`
	BytesApprox int64 `json:"bytesApprox"`
}

// LookupResult is what Lookup returns. When Hit is false, Response is
// empty.
type LookupResult struct {
	Hit        bool    `json:"hit"`
	Response   string  `json:"response"`
	Similarity float64 `json:"similarity"`
	Source     string  `json:"source"` // the cached prompt that matched
}

// Cache is the in-process store. Safe for concurrent use.
type Cache struct {
	mu        sync.Mutex
	config    Config
	entries   []*Entry
	hits      int64
	misses    int64
	dirty     bool
	saveTimer *time.Timer
}

// New loads the cache from disk, or returns an empty one when no file
// exists. Never fails — a broken JSON file is replaced by an empty
// cache (cache state is non-load-bearing).
func New() *Cache {
	c := &Cache{config: DefaultConfig}
	c.loadFromDisk()
	return c
}

// ─── Public API ──────────────────────────────────────────────────────────

// Lookup returns a hit when the prompt's cosine similarity to a stored
// entry exceeds the threshold. Updates LRU + hit count.
func (c *Cache) Lookup(prompt string) LookupResult {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.config.Enabled {
		c.misses++
		return LookupResult{Hit: false}
	}

	now := time.Now().UnixMilli()
	queryTokens := tokenize(prompt)
	if len(queryTokens) == 0 {
		c.misses++
		return LookupResult{Hit: false}
	}
	queryVec := tokenFrequency(queryTokens)

	var bestEntry *Entry
	var bestSim float64

	// Single pass: evict expired, find best match.
	keep := c.entries[:0]
	ttlMs := c.config.TTLSeconds * 1000
	for _, e := range c.entries {
		if ttlMs > 0 && now-e.CreatedAtMs > ttlMs {
			c.dirty = true
			continue
		}
		keep = append(keep, e)
		sim := cosineSimilarity(queryVec, tokenFrequency(e.Tokens))
		if sim > bestSim {
			bestSim = sim
			bestEntry = e
		}
	}
	c.entries = keep

	if bestEntry == nil || bestSim < c.config.Threshold {
		c.misses++
		return LookupResult{Hit: false, Similarity: bestSim}
	}

	bestEntry.Hits++
	bestEntry.LastUsedAtMs = now
	c.hits++
	c.dirty = true
	c.scheduleSave()
	return LookupResult{
		Hit:        true,
		Response:   bestEntry.Response,
		Similarity: bestSim,
		Source:     bestEntry.Prompt,
	}
}

// Store records a fresh (prompt, response) pair. No-op when caching is
// disabled. LRU-evicts oldest entries to honour MaxEntries.
func (c *Cache) Store(prompt, response string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.config.Enabled {
		return
	}
	if prompt == "" || response == "" {
		return
	}

	now := time.Now().UnixMilli()
	tokens := tokenize(prompt)
	if len(tokens) == 0 {
		return
	}

	// Replace existing identical entry if there is one.
	for _, e := range c.entries {
		if e.Prompt == prompt {
			e.Response = response
			e.LastUsedAtMs = now
			c.dirty = true
			c.scheduleSave()
			return
		}
	}

	c.entries = append(c.entries, &Entry{
		Prompt:       prompt,
		Response:     response,
		Tokens:       tokens,
		CreatedAtMs:  now,
		LastUsedAtMs: now,
	})

	// LRU eviction.
	if c.config.MaxEntries > 0 && len(c.entries) > c.config.MaxEntries {
		sort.Slice(c.entries, func(i, j int) bool {
			return c.entries[i].LastUsedAtMs < c.entries[j].LastUsedAtMs
		})
		over := len(c.entries) - c.config.MaxEntries
		c.entries = c.entries[over:]
	}

	c.dirty = true
	c.scheduleSave()
}

// Stats snapshots the current counters.
func (c *Cache) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	total := c.hits + c.misses
	ratio := 0.0
	if total > 0 {
		ratio = float64(c.hits) / float64(total)
	}
	bytes := int64(0)
	for _, e := range c.entries {
		bytes += int64(len(e.Prompt) + len(e.Response) + 32)
	}
	return Stats{
		Enabled:     c.config.Enabled,
		Entries:     len(c.entries),
		Hits:        c.hits,
		Misses:      c.misses,
		HitRatio:    ratio,
		BytesApprox: bytes,
	}
}

// Config returns the current settings.
func (c *Cache) Config() Config {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.config
}

// SetConfig replaces the settings + persists.
func (c *Cache) SetConfig(cfg Config) {
	c.mu.Lock()
	c.config = sanitizeConfig(cfg)
	c.dirty = true
	c.mu.Unlock()
	c.Save()
}

// Clear drops every entry. Counters are NOT reset — those describe
// lifetime hit rate, not current contents.
func (c *Cache) Clear() {
	c.mu.Lock()
	c.entries = nil
	c.dirty = true
	c.mu.Unlock()
	c.Save()
}

// Save force-flushes to disk immediately. Called by the IPC layer
// before app shutdown.
func (c *Cache) Save() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.saveLocked()
}

// ─── Persistence ─────────────────────────────────────────────────────────

type persisted struct {
	Config  Config   `json:"_config"`
	Entries []*Entry `json:"entries"`
	Hits    int64    `json:"hits"`
	Misses  int64    `json:"misses"`
}

func cachePath() (string, error) {
	root, err := paths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "promptcache.json"), nil
}

func (c *Cache) loadFromDisk() {
	path, err := cachePath()
	if err != nil {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var p persisted
	if err := json.Unmarshal(b, &p); err != nil {
		return
	}
	c.config = sanitizeConfig(p.Config)
	c.entries = p.Entries
	c.hits = p.Hits
	c.misses = p.Misses
}

func (c *Cache) saveLocked() {
	if !c.dirty {
		return
	}
	path, err := cachePath()
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	p := persisted{
		Config:  c.config,
		Entries: c.entries,
		Hits:    c.hits,
		Misses:  c.misses,
	}
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, b, 0o644)
	c.dirty = false
}

// scheduleSave debounces autosaves: a Lookup or Store schedules a save
// 2 seconds out, which gets reset on subsequent activity so a burst
// of cache writes is one disk flush.
func (c *Cache) scheduleSave() {
	if c.saveTimer != nil {
		c.saveTimer.Reset(2 * time.Second)
		return
	}
	c.saveTimer = time.AfterFunc(2*time.Second, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.saveLocked()
	})
}

func sanitizeConfig(c Config) Config {
	if c.Threshold < 0 {
		c.Threshold = 0
	}
	if c.Threshold > 1 {
		c.Threshold = 1
	}
	if c.TTLSeconds < 0 {
		c.TTLSeconds = 0
	}
	if c.MaxEntries < 0 {
		c.MaxEntries = 0
	}
	if c.Threshold == 0 && !c.Enabled {
		// Fresh DefaultConfig with no overrides; keep defaults.
		c.Threshold = DefaultConfig.Threshold
		c.TTLSeconds = DefaultConfig.TTLSeconds
		c.MaxEntries = DefaultConfig.MaxEntries
	}
	return c
}

// ─── Similarity ─────────────────────────────────────────────────────────

// tokenize lowercases, strips simple punctuation, splits on whitespace.
// Simple and deterministic. Stop-word removal would help precision but
// hurt recall on short prompts; we leave them in.
func tokenize(s string) []string {
	s = strings.ToLower(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case '.', ',', '!', '?', ';', ':', '"', '\'', '(', ')', '[', ']', '{', '}', '/', '\\', '`':
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	return strings.Fields(b.String())
}

// tokenFrequency builds a {token: count} map. Map keys are interned by
// the Go runtime so two passes over the same prompt produce identical
// vectors for cosine comparison.
func tokenFrequency(tokens []string) map[string]int {
	m := make(map[string]int, len(tokens))
	for _, t := range tokens {
		m[t]++
	}
	return m
}

// cosineSimilarity over two TF maps. Sparse: only the union of keys
// matters. Empty input -> 0.
func cosineSimilarity(a, b map[string]int) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	var dot, na, nb float64
	for k, v := range a {
		af := float64(v)
		na += af * af
		if vb, ok := b[k]; ok {
			dot += af * float64(vb)
		}
	}
	for _, v := range b {
		bf := float64(v)
		nb += bf * bf
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}
