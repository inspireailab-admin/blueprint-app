// Package main is the Wails desktop application binding for Blueprint.
//
// The Go side of the app is a thin shell that wires the Blueprint kernel
// (catalog, paths, runtime, download — published from inspireailab-admin/
// blueprint as github.com/inspireailab-admin/blueprint/pkg/*) into the
// Wails IPC layer. Anything exposed on the App struct as a method becomes
// callable from the frontend via Wails's generated bindings.

package main

import (
	"context"

	"github.com/inspireailab-admin/blueprint/pkg/catalog"
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
// to confirm the app + kernel are wired correctly. Bumped to a richer
// surface (build SHA, GPU detected, etc.) once those data sources land.
type VersionInfo struct {
	App        string `json:"app"`
	ModelCount int    `json:"modelCount"`
}

// Version returns the app version and the number of models the kernel
// can see. First IPC call wired in Phase 1 — proves the frontend can
// reach Go and Go can reach the Blueprint kernel.
func (a *App) Version() (VersionInfo, error) {
	models, err := catalog.Load()
	if err != nil {
		return VersionInfo{}, err
	}
	return VersionInfo{
		App:        AppVersion,
		ModelCount: len(models),
	}, nil
}
