// Package logging is Blueprint's leveled structured-logging facade.
// Every package that does I/O — SSH, HTTP, model downloads, subprocess
// supervision — funnels its operational logs through here so they
// land in one rotated file under ~/.blueprint/logs/blueprint.log and
// on stderr (which systemd / launchd / the Windows service wrapper
// capture for their own journals).
//
// We deliberately wrap log/slog rather than use it directly so:
//   - File destination resolves lazily; tests don't write to ~/.blueprint
//   - Rotation is built in (no external dependency)
//   - Future formatting / sink changes are one-file edits, not a
//     project-wide sweep
//
// Usage:
//
//	logging.L().Info("ssh dial succeeded", "host", h.Host)
//	logging.L().Error("svc health probe failed", "err", err)
//
// Author: Amar Mond.
package logging

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"
)

const (
	// logFileName is the active log file the package writes to inside
	// the per-user logs directory.
	logFileName = "blueprint.log"

	// maxLogSize is the byte threshold at which the active log is
	// rotated to `<name>.old` (single backup). We rotate at startup
	// only — no mid-process rotation — which is enough for a desktop
	// app or a long-running svc that restarts on upgrade.
	maxLogSize = 10 * 1024 * 1024
)

var (
	initOnce sync.Once
	logger   *slog.Logger
)

// L returns the package-wide logger. Safe to call from any goroutine;
// initializes on first use and is a no-op on subsequent calls.
//
// The returned *slog.Logger is the standard library type, so callers
// get every slog feature (With, WithGroup, structured key/value
// attrs) for free.
func L() *slog.Logger {
	initOnce.Do(initLogger)
	return logger
}

// SetLevel changes the minimum log level emitted by the package-wide
// logger. Defaults to Info. Wired up for future config plumbing —
// today nothing calls it, but it's here so a verbosity flag is a
// one-line addition.
func SetLevel(level slog.Level) {
	levelVar.Set(level)
}

// levelVar is the dynamic level pointer the handler reads on every
// log call. Exposing it through SetLevel lets us flip verbosity at
// runtime without rebuilding the handler chain.
var levelVar = new(slog.LevelVar)

// initLogger wires slog up to write to the rotated file in
// ~/.blueprint/logs/ AND stderr. Falls back to stderr-only when
// paths.Root() fails (sandbox, no $HOME) — we never want logging
// itself to break the app.
func initLogger() {
	levelVar.Set(slog.LevelInfo)

	var sink io.Writer = os.Stderr
	if f, err := openRotated(); err == nil {
		sink = io.MultiWriter(os.Stderr, f)
	}

	logger = slog.New(slog.NewTextHandler(sink, &slog.HandlerOptions{
		Level: levelVar,
	}))
}

// openRotated returns an append-mode file handle to the active log,
// rotating it to `<name>.old` first if it has grown past maxLogSize.
// The .old file is overwritten on each rotation — one backup is
// enough for incident triage without unbounded disk use.
func openRotated() (*os.File, error) {
	root, err := paths.Root()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(root, "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, logFileName)

	if info, err := os.Stat(path); err == nil && info.Size() > maxLogSize {
		// Best-effort rotation. If rename fails (e.g. .old is held
		// open on Windows by a previous instance) we just keep
		// appending to the active file — better than dropping logs.
		_ = os.Rename(path, path+".old")
	}
	return os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
}
