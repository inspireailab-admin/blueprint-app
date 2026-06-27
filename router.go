// Router IPC surface. The frontend uses this for config CRUD + stats
// rendering; routing decisions themselves happen client-side in
// DashboardChat (one IPC roundtrip per chat is enough).
//
// Author: Amar Mond.
package main

import (
	"sync"

	"github.com/inspireailab-admin/blueprint-app/internal/router"
)

var (
	routerOnce sync.Once
	routerInst *router.Router
)

func getRouter() *router.Router {
	routerOnce.Do(func() {
		routerInst = router.New()
	})
	return routerInst
}

// RouterConfig returns the current router settings.
func (a *App) RouterConfig() router.Config { return getRouter().Config() }

// SetRouterConfig persists new router settings.
func (a *App) SetRouterConfig(cfg router.Config) { getRouter().SetConfig(cfg) }

// RouterStats returns lifetime route distribution.
func (a *App) RouterStats() router.Stats { return getRouter().Stats() }

// RouterShouldSkipToLarge — frontend asks before the small call: does
// this prompt's prefix match the always-escalate rule? If yes, skip
// the small call entirely.
func (a *App) RouterShouldSkipToLarge(prompt string) bool {
	return getRouter().ShouldSkipToLarge(prompt)
}

// RouterShouldEscalate — frontend asks after the small response: does
// any escalation pattern match? Returns the matching pattern or "" if
// no escalation is needed.
func (a *App) RouterShouldEscalate(response string) string {
	return getRouter().ShouldEscalate(response)
}

// RouterRecordSmallOnly bumps the "small handled it" counter.
func (a *App) RouterRecordSmallOnly() { getRouter().RecordSmallOnly() }

// RouterRecordEscalated bumps the "small bailed, large served" counter.
func (a *App) RouterRecordEscalated() { getRouter().RecordEscalated() }

// RouterRecordPrefixSkipped bumps the "prefix rule skipped small" counter.
func (a *App) RouterRecordPrefixSkipped() { getRouter().RecordPrefixSkipped() }

// RouterResetStats zeros counters; settings survive.
func (a *App) RouterResetStats() { getRouter().ResetStats() }
