// Supervisor — cross-platform core. The actual loop that reads
// %ProgramData%\Blueprint\service-config.json (or its Linux equivalent
// under /etc/blueprint/), spawns llama-server, supervises it with
// restart-on-crash + exponential backoff, and writes service-status.json
// so the desktop app can render state without an IPC channel.
//
// The platform-specific bits are thin wrappers:
//   - supervisor_windows.go drives this via svc.Handler.Execute().
//   - main_linux.go drives this with a signal handler in main().
//
// In both cases the bridge just creates a context, calls runSupervisor,
// cancels on shutdown.

package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/engines"
	"github.com/inspireailab-admin/blueprint-app/internal/svcapi"
	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

// AppVersion is overridden at build time via
//
//	-ldflags "-X main.AppVersion=0.2.x"
//
// Falls back to "dev" for unversioned local builds.
var AppVersion = "dev"

// apiStarted ensures we never bind the control-plane port twice if the
// supervisor loop happens to re-run (which it doesn't today, but safer
// to be idempotent).
var apiStarted atomic.Bool

// startAPIOnce launches the HTTP control plane in a background goroutine.
// Best-effort — if the port is already bound (another blueprint-svc
// instance? a curious user?) we log and keep going; the supervisor's
// llama-server duties don't depend on the API.
func startAPIOnce() {
	if !apiStarted.CompareAndSwap(false, true) {
		return
	}
	server, err := svcapi.New(AppVersion)
	if err != nil {
		log.Printf("svcapi: %v", err)
		return
	}
	log.Printf("svcapi: control plane bound on 127.0.0.1:%d", svcapi.DefaultPort)
	go func() {
		if err := server.ListenAndServe(0); err != nil {
			log.Printf("svcapi: serve exited: %v", err)
		}
	}()
}

// runSupervisor is the actual loop. Returns when ctx is cancelled.
//
// childTracker is optional — when non-nil, every spawned child registers
// itself so the platform shutdown path can hard-kill on grace timeout.
type runSupervisorOpts struct {
	onChildStart func(cmd *exec.Cmd, cancel context.CancelFunc)
	onChildEnd   func()
}

func runSupervisor(ctx context.Context, opts runSupervisorOpts) {
	startAPIOnce()
	writeStatus(svcconfig.Status{Phase: "idle"})

	var restartCount int
	backoff := time.Second

	for {
		if ctx.Err() != nil {
			return
		}

		cfg, err := svcconfig.ReadConfig()
		if err != nil {
			log.Printf("read config: %v", err)
			writeStatus(svcconfig.Status{Phase: "idle", LastError: err.Error()})
			if !sleepCtx(ctx, 5*time.Second) {
				return
			}
			continue
		}
		if cfg == nil || cfg.LlamaServerBin == "" || cfg.ModelPath == "" {
			// No config or incomplete — sit idle and poll for it.
			writeStatus(svcconfig.Status{Phase: "idle"})
			if !sleepCtx(ctx, 5*time.Second) {
				return
			}
			continue
		}

		logFile, err := openLogFile()
		if err != nil {
			writeStatus(svcconfig.Status{Phase: "idle", LastError: "open log: " + err.Error()})
			if !sleepCtx(ctx, 5*time.Second) {
				return
			}
			continue
		}

		engine := engines.Get(cfg.Engine)
		engineBin, err := engine.Binary()
		if err != nil {
			logFile.Close()
			detail := err.Error()
			if errors.Is(err, engines.ErrNotImplemented) {
				detail = engine.Info().DisplayName + " engine is not yet implemented — pick llama-cpp"
			}
			writeStatus(svcconfig.Status{Phase: "crashed", LastError: detail})
			if !sleepCtx(ctx, 5*time.Second) {
				return
			}
			continue
		}
		// Fallback: if the config still carries the legacy
		// LlamaServerBin (older apps wrote it explicitly), respect
		// that override.
		if cfg.LlamaServerBin != "" && cfg.Engine == "" {
			engineBin = cfg.LlamaServerBin
		}

		childCtx, cc := context.WithCancel(ctx)
		cmd := exec.CommandContext(childCtx, engineBin, engine.Args(cfg)...)
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		hideConsole(cmd)

		startedAt := time.Now().UnixMilli()
		if err := cmd.Start(); err != nil {
			logFile.Close()
			cc()
			writeStatus(svcconfig.Status{Phase: "crashed", LastError: "start: " + err.Error(), RestartCount: restartCount})
			if !sleepCtx(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			restartCount++
			if cfg.MaxRestarts > 0 && restartCount >= cfg.MaxRestarts {
				writeStatus(svcconfig.Status{Phase: "crashed", LastError: "max restarts exceeded", RestartCount: restartCount})
				return
			}
			continue
		}

		pid := cmd.Process.Pid
		writeStatus(svcconfig.Status{
			Phase: "running", ModelID: cfg.ModelID, Quant: cfg.Quant,
			PID: pid, Port: cfg.Port, BindHost: cfg.BindHost,
			StartedAtMs: startedAt, RestartCount: restartCount,
		})
		log.Printf("supervisor: spawned llama-server pid=%d model=%s quant=%s", pid, cfg.ModelID, cfg.Quant)

		if opts.onChildStart != nil {
			opts.onChildStart(cmd, cc)
		}

		err = cmd.Wait()
		logFile.Close()

		if opts.onChildEnd != nil {
			opts.onChildEnd()
		}

		if ctx.Err() != nil {
			return
		}

		if time.Now().UnixMilli()-startedAt > 60_000 {
			backoff = time.Second
			restartCount = 0
		}
		restartCount++

		lastErr := ""
		if err != nil {
			lastErr = err.Error()
		}
		writeStatus(svcconfig.Status{
			Phase: "crashed", ModelID: cfg.ModelID, Quant: cfg.Quant,
			RestartCount: restartCount, LastError: lastErr,
		})
		log.Printf("supervisor: child exited (%v), restart in %s (count=%d)", err, backoff, restartCount)

		if cfg.MaxRestarts > 0 && restartCount >= cfg.MaxRestarts {
			log.Printf("supervisor: max restarts (%d) reached, giving up", cfg.MaxRestarts)
			return
		}
		if !sleepCtx(ctx, backoff) {
			return
		}
		backoff = nextBackoff(backoff)
	}
}

// childTracker is a tiny helper shared by the platform bridges so they
// can hard-kill the running child on shutdown grace expiry.
type childTracker struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	cancel context.CancelFunc
}

func (t *childTracker) set(cmd *exec.Cmd, cancel context.CancelFunc) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cmd = cmd
	t.cancel = cancel
}

func (t *childTracker) clear() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cmd = nil
	t.cancel = nil
}

func (t *childTracker) snapshot() (*exec.Cmd, context.CancelFunc) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cmd, t.cancel
}

// llamaArgs was the old direct args builder; it now lives in
// internal/engines.LlamaCpp.Args. The supervisor dispatches through
// engines.Get(cfg.Engine).

func openLogFile() (writeCloser, error) {
	path, err := svcconfig.LogPath()
	if err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
}

// writeCloser is just io.WriteCloser; the alias keeps the dependency
// graph of this file empty of the io package since openLogFile is the
// only caller and *os.File satisfies the interface.
type writeCloser interface {
	Write(p []byte) (int, error)
	Close() error
}

func writeStatus(s svcconfig.Status) {
	s.UpdatedAt = time.Now().UnixMilli()
	_ = svcconfig.WriteStatus(s)
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func nextBackoff(d time.Duration) time.Duration {
	next := d * 2
	if next > 30*time.Second {
		next = 30 * time.Second
	}
	return next
}
