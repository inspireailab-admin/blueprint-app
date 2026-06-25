//go:build windows

// Supervisor — the bit that actually keeps llama-server up.
//
// Lifecycle:
//
//  1. SCM calls Execute(); we send StartPending, then start a worker.
//  2. Worker loop reads the on-disk config, spawns llama-server, waits.
//  3. If the child exits with a non-zero code or crashes, we wait an
//     exponentially-backed-off interval and respawn — up to MaxRestarts
//     consecutive failures, then we give up and log it.
//  4. When SCM sends Stop, we cancel, kill the child, mark Status =
//     "stopped", and return.
//
// Status writes go to %ProgramData%\Blueprint\service-status.json so
// the desktop app can render the phase + PID + restart count without
// any IPC.

package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows/svc"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

type supervisor struct{}

// Execute is the svc.Handler entry point.
func (s *supervisor) Execute(args []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	status <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var (
		childMu     sync.Mutex
		childCmd    *exec.Cmd
		childCancel context.CancelFunc
	)

	// Worker — supervises one child at a time. Restart-on-crash with
	// exponential backoff capped at 30s.
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)

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

			// Spawn the child.
			logFile, err := openLogFile()
			if err != nil {
				writeStatus(svcconfig.Status{Phase: "idle", LastError: "open log: " + err.Error()})
				if !sleepCtx(ctx, 5*time.Second) {
					return
				}
				continue
			}

			childCtx, cc := context.WithCancel(ctx)
			cmd := exec.CommandContext(childCtx, cfg.LlamaServerBin, llamaArgs(cfg)...)
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

			childMu.Lock()
			childCmd = cmd
			childCancel = cc
			childMu.Unlock()

			err = cmd.Wait()
			logFile.Close()

			childMu.Lock()
			childCmd = nil
			childCancel = nil
			childMu.Unlock()

			if ctx.Err() != nil {
				// Service stop requested — get out clean.
				return
			}

			// Survived a successful run for >= 60s? Reset backoff.
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
	}()

	status <- svc.Status{State: svc.Running, Accepts: accepted}

	// SCM command loop.
	for c := range r {
		switch c.Cmd {
		case svc.Interrogate:
			status <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			cancel()

			// Hard-kill the child after a 5s grace period.
			childMu.Lock()
			if childCmd != nil && childCmd.Process != nil {
				go func(p *os.Process) {
					time.Sleep(5 * time.Second)
					_ = p.Kill()
				}(childCmd.Process)
				if childCancel != nil {
					childCancel()
				}
			}
			childMu.Unlock()

			// Wait for worker.
			select {
			case <-workerDone:
			case <-time.After(10 * time.Second):
				log.Printf("supervisor: worker didn't exit in 10s, force-returning")
			}

			writeStatus(svcconfig.Status{Phase: "stopped"})
			return false, 0
		}
	}
	return false, 0
}

func llamaArgs(cfg *svcconfig.Config) []string {
	args := []string{
		"--model", cfg.ModelPath,
		"--host", cfg.BindHost,
		"--port", strconv.Itoa(cfg.Port),
		"--ctx-size", strconv.Itoa(cfg.CtxSize),
		"--n-gpu-layers", strconv.Itoa(cfg.NGpuLayers),
	}
	if cfg.APIKey != "" {
		args = append(args, "--api-key", cfg.APIKey)
	}
	if cfg.EnableMetrics {
		args = append(args, "--metrics")
	}
	return args
}

func openLogFile() (io.WriteCloser, error) {
	path, err := svcconfig.LogPath()
	if err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
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

// hideConsole hides the child's console window so spawning llama-server
// doesn't briefly flash a CMD.
func hideConsole(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}

// Silence unused-import warnings when extending.
var _ = fmt.Sprintf
