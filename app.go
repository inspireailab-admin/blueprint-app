// Package main is the Wails desktop application binding for Blueprint.
//
// The Go side of the app is a thin shell that wires the Blueprint kernel
// (catalog, paths, runtime, download — published from inspireailab-admin/
// blueprint as github.com/inspireailab-admin/blueprint-cli/pkg/*) into the
// Wails IPC layer. Anything exposed on the App struct as a method becomes
// callable from the frontend via Wails's generated bindings.
//
// Author: Amar Mond.
package main

import (
	"context"

	"github.com/inspireailab-admin/blueprint-cli/pkg/catalog"
)

// AppVersion is the desktop app's user-facing version. Override at link
// time with -ldflags "-X main.AppVersion=v0.1.0" so release builds report
// their tag without code changes.
var AppVersion = "0.0.1-dev"

// App is the binding surface exposed to the Wails frontend. Methods on
// this struct are auto-generated into `frontend/wailsjs/go/main/App.js`
// so the React app can call them with one line.
type App struct {
	ctx context.Context
}

// NewApp creates a new App instance. Called from main.go.
func NewApp() *App {
	return &App{}
}

// startup runs after the window is created. Stash the context so we can
// emit runtime events back to the frontend later.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// VersionInfo is what the frontend renders at the bottom of the window
// to confirm the app + kernel are wired correctly.
type VersionInfo struct {
	App         string `json:"app"`
	CatalogAsOf string `json:"catalogAsOf"`
	ModelCount  int    `json:"modelCount"`
}

// Version returns the app version, the catalog "as of" date, and the
// model count. Cheap call, used by the status bar.
func (a *App) Version() (VersionInfo, error) {
	cat, err := catalog.LoadFull()
	if err != nil {
		return VersionInfo{}, err
	}
	return VersionInfo{
		App:         AppVersion,
		CatalogAsOf: cat.AsOf,
		ModelCount:  len(cat.Models),
	}, nil
}

// Catalog returns the full embedded model catalog. The Plan tab calls
// this once on mount and caches in React state; subsequent filter /
// rank work happens entirely in the frontend.
func (a *App) Catalog() (catalog.Catalog, error) {
	return catalog.LoadFull()
}
