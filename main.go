// Blueprint — the desktop application for running open LLMs on your
// own hardware. Plan a model, size the hardware, deploy locally,
// monitor, and maintain — without leaving the app or learning the
// CLI under the hood.
//
// The Wails framework wires a Go backend to a React/Vite frontend
// embedded as static assets. main.go is the entry point: it wires
// the App struct (in app.go) to the window options and runs the
// event loop until the user closes the window.
//
// Author: Amar Mond.
package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "Blueprint",
		Width:     1280,
		Height:    820,
		MinWidth:  960,
		MinHeight: 640,
		// Open maximized — Blueprint is a dashboard app, the user wants
		// the full system view, not a tiny 1280×820 floating window.
		// The user can still hit the Restore icon to drop to the
		// Width × Height defined above.
		WindowStartState: options.Maximised,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		// Light background by default; the frontend's Tailwind layer
		// owns the actual chrome.
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
