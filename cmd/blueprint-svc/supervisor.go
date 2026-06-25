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
	"log"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

// runSupervisor is the actual loop. Returns when ctx is cancelled.
//
// childTracker is optional — when non-nil, every spawned child registers
// itself so the platform shutdown path can hard-kill on grace timeout.
type runSupervisorOpts struct {
	onChildStart func(cmd *exec.Cmd, cancel context.CancelFunc)
	onChildEnd   func()
}

func runSupervisor(ctx context.Context, opts runSupervisorOpts) {
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
	// Advanced startup flags — only emitted when set so we don't
	// override llama.cpp's sensible defaults unnecessarily.
	if cfg.Threads > 0 {
		args = append(args, "--threads", strconv.Itoa(cfg.Threads))
	}
	if cfg.BatchSize > 0 {
		args = append(args, "--batch-size", strconv.Itoa(cfg.BatchSize))
	}
	if cfg.UBatchSize > 0 {
		args = append(args, "--ubatch-size", strconv.Itoa(cfg.UBatchSize))
	}
	if cfg.FlashAttn {
		args = append(args, "--flash-attn")
	}
	if cfg.MemoryLock {
		args = append(args, "--mlock")
	}
	if cfg.NoMmap {
		args = append(args, "--no-mmap")
	}
	if cfg.ParallelSlots > 0 {
		args = append(args, "--parallel", strconv.Itoa(cfg.ParallelSlots))
	}
	if cfg.ContBatching {
		args = append(args, "--cont-batching")
	}
	if cfg.KvCacheTypeK != "" {
		args = append(args, "--cache-type-k", cfg.KvCacheTypeK)
	}
	if cfg.KvCacheTypeV != "" {
		args = append(args, "--cache-type-v", cfg.KvCacheTypeV)
	}
	if cfg.LogVerbose {
		args = append(args, "--verbose")
	}
	// LoRA adapter — applied on top of the base model at load time.
	// llama-server accepts the path via --lora and the blend via
	// --lora-scaled <path> <scale>. We use --lora-scaled even at
	// scale=1.0 because it's the most explicit form.
	if cfg.LoraAdapter != "" {
		scale := cfg.LoraScale
		if scale <= 0 {
			scale = 1.0
		}
		args = append(args, "--lora-scaled", cfg.LoraAdapter, strconv.FormatFloat(scale, 'f', -1, 64))
	}
	return args
}

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
