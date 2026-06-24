// First-run state. The welcome overlay shows once, the first time the
// app launches on a given machine. After the user dismisses it we drop
// a marker file in ~/.blueprint/.first-run-done so it never shows again.
//
// Implemented as App methods so the frontend can ask + acknowledge
// without bothering with paths.

package main

import (
	"os"
	"path/filepath"

	"github.com/inspireailab-admin/blueprint/pkg/paths"
)

const firstRunMarker = ".first-run-done"

// FirstRun returns true the first time a user launches the app on a
// given machine. Best-effort: if paths.Root() fails for any reason we
// quietly default to false rather than showing the welcome on every
// launch.
func (a *App) FirstRun() bool {
	root, err := paths.Root()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(root, firstRunMarker))
	return os.IsNotExist(err)
}

// MarkFirstRunDone writes the marker so FirstRun returns false on
// subsequent launches. Called from the frontend when the user
// dismisses the welcome.
func (a *App) MarkFirstRunDone() error {
	root, err := paths.Root()
	if err != nil {
		return err
	}
	if err := paths.EnsureDir(root); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, firstRunMarker), []byte("done\n"), 0o644)
}
