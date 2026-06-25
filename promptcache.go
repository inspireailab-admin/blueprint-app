// Prompt-cache IPC surface. Wires the in-process Cache instance into
// Wails so the frontend (DashboardChat and any future surface) can
// look up and store responses, see stats, and toggle settings.
//
// The cache is a single App-scoped instance — desktop apps are
// single-user so global state is fine.

package main

import (
	"sync"

	"github.com/inspireailab-admin/blueprint-app/internal/promptcache"
)

// Single cache instance, lazily constructed on first use. Saves on
// app shutdown via app.go's hookpoint (if/when we wire it).
var (
	cacheOnce sync.Once
	cache     *promptcache.Cache
)

func getCache() *promptcache.Cache {
	cacheOnce.Do(func() {
		cache = promptcache.New()
	})
	return cache
}

// LookupPromptCache returns a cache hit + the cached response, or a
// miss. The frontend calls this immediately before sending a chat
// completion; on hit, it returns the cached text without ever
// touching llama-server.
func (a *App) LookupPromptCache(prompt string) promptcache.LookupResult {
	return getCache().Lookup(prompt)
}

// StorePromptCache records a (prompt, response) pair the cache should
// remember. The frontend calls this after a successful stream
// completes.
func (a *App) StorePromptCache(prompt, response string) {
	getCache().Store(prompt, response)
}

// PromptCacheStats returns the current snapshot for the Dashboard's
// cache card.
func (a *App) PromptCacheStats() promptcache.Stats {
	return getCache().Stats()
}

// PromptCacheConfig returns the current settings so the Dashboard's
// cache card can render them with the right defaults.
func (a *App) PromptCacheConfig() promptcache.Config {
	return getCache().Config()
}

// SetPromptCacheConfig replaces the settings + persists. The UI calls
// this when the user toggles "Enable" or adjusts the threshold.
func (a *App) SetPromptCacheConfig(cfg promptcache.Config) {
	getCache().SetConfig(cfg)
}

// ClearPromptCache drops every entry. Counters survive — they describe
// lifetime hit rate, not current contents.
func (a *App) ClearPromptCache() {
	getCache().Clear()
}
