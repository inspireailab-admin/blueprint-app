// Deploy IPC surface. Mounts the kernel's runtime install + GGUF pull +
// llama-server supervision behind a small set of methods on the App
// struct, with Wails events for streaming progress and log output.
//
// Event names emitted from this file (all string payloads where not noted):
//
//   deploy:runtime-stage    {stage, detail}     — locating / downloading / extracting / done
//   deploy:runtime-progress {bytes, total, bps} — runtime download bytes
//   deploy:pull-progress    {bytes, total, bps} — model GGUF download bytes
//   deploy:serve-log        {line}              — llama-server stdout/stderr line
//   deploy:serve-status     {state, port, pid}  — running / starting / stopped
//
// Long-running methods (InstallRuntime, PullModel, StartServe) return as
// soon as the work is kicked off in a goroutine — the UI listens to the
// events to track progress.

package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/inspireailab-admin/blueprint/pkg/catalog"
	"github.com/inspireailab-admin/blueprint/pkg/download"
	"github.com/inspireailab-admin/blueprint/pkg/paths"
	"github.com/inspireailab-admin/blueprint/pkg/runtime"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// ─── Runtime status ────────────────────────────────────────────────────────

// RuntimeStatus reports whether llama.cpp is installed and where it lives.
type RuntimeStatus struct {
	Installed bool   `json:"installed"`
	Version   string `json:"version"`
	BinPath   string `json:"binPath"`
}

// RuntimeStatus is exported to the frontend.
func (a *App) RuntimeStatus() RuntimeStatus {
	bin, err := paths.Bin()
	if err != nil {
		return RuntimeStatus{}
	}
	v := runtime.InstalledVersion()
	return RuntimeStatus{
		Installed: v != "",
		Version:   v,
		BinPath:   bin,
	}
}

// InstallRuntime fetches the latest llama.cpp release and extracts it.
// Returns immediately; the work runs in a goroutine. The UI tracks
// progress via deploy:runtime-stage and deploy:runtime-progress events.
func (a *App) InstallRuntime() error {
	go func() {
		ctx := context.Background()
		err := runtime.InstallWithOptions(ctx, runtime.InstallOptions{
			OnStage: func(stage, detail string) {
				wailsruntime.EventsEmit(a.ctx, "deploy:runtime-stage",
					map[string]string{"stage": stage, "detail": detail})
			},
			OnProgress: func(p download.Progress) {
				wailsruntime.EventsEmit(a.ctx, "deploy:runtime-progress",
					map[string]int64{"bytes": p.BytesDownloaded, "total": p.BytesTotal, "bps": p.BytesPerSecond})
			},
		})
		if err != nil {
			wailsruntime.EventsEmit(a.ctx, "deploy:runtime-stage",
				map[string]string{"stage": "error", "detail": err.Error()})
		}
	}()
	return nil
}

// ─── Model pull ────────────────────────────────────────────────────────────

// ModelStatus reports whether the given model + quant GGUF is on disk.
type ModelStatus struct {
	Present  bool   `json:"present"`
	Path     string `json:"path"`
	BytesGGB int64  `json:"bytesGB"`
}

// ModelStatus is exported to the frontend.
func (a *App) ModelStatus(modelID, quant string) (ModelStatus, error) {
	model, err := catalog.Get(modelID)
	if err != nil {
		return ModelStatus{}, err
	}
	fileName, ok := model.QuantFiles()[quant]
	if !ok {
		return ModelStatus{}, fmt.Errorf("model %s has no %s GGUF", modelID, quant)
	}
	dst, err := paths.ModelFile(modelID, fileName)
	if err != nil {
		return ModelStatus{}, err
	}
	info, err := os.Stat(dst)
	if err != nil {
		return ModelStatus{Path: dst}, nil
	}
	return ModelStatus{Present: true, Path: dst, BytesGGB: info.Size()}, nil
}

// PullModel fetches the GGUF for the given model + quant. Returns
// immediately; download progress streams over deploy:pull-progress.
func (a *App) PullModel(modelID, quant string) error {
	model, err := catalog.Get(modelID)
	if err != nil {
		return err
	}
	url, fileName, err := model.DownloadURL(quant)
	if err != nil {
		return err
	}
	dst, err := paths.ModelFile(modelID, fileName)
	if err != nil {
		return err
	}

	go func() {
		err := download.FileWithOptions(context.Background(), url, dst, download.Options{
			OnProgress: func(p download.Progress) {
				wailsruntime.EventsEmit(a.ctx, "deploy:pull-progress",
					map[string]int64{"bytes": p.BytesDownloaded, "total": p.BytesTotal, "bps": p.BytesPerSecond})
			},
		})
		if err != nil {
			wailsruntime.EventsEmit(a.ctx, "deploy:pull-progress",
				map[string]string{"error": err.Error()})
			return
		}
		wailsruntime.EventsEmit(a.ctx, "deploy:pull-progress",
			map[string]string{"stage": "done"})
	}()
	return nil
}

// ─── Serve ────────────────────────────────────────────────────────────────

const (
	localAPIKey = "blueprint-local"
	servePort   = 8080
)

// ServerStatus reports the current llama-server state. The frontend
// renders the state into a coloured chip in the Deploy tab.
type ServerStatus struct {
	State   string `json:"state"`             // "stopped" | "starting" | "running"
	ModelID string `json:"modelId,omitempty"` // running model id
	Quant   string `json:"quant,omitempty"`
	Port    int    `json:"port,omitempty"`
	PID     int    `json:"pid,omitempty"`
}

// serveProc holds the currently-supervised llama-server process. Nil
// when nothing is running. Protected by serveMu.
var (
	serveMu     sync.Mutex
	serveProc   *exec.Cmd
	serveState  = "stopped"
	serveModel  string
	serveQuant  string
	serveCancel context.CancelFunc
)

// ServerStatus is exported to the frontend.
func (a *App) ServerStatus() ServerStatus {
	serveMu.Lock()
	defer serveMu.Unlock()
	status := ServerStatus{State: serveState, ModelID: serveModel, Quant: serveQuant, Port: servePort}
	if serveProc != nil && serveProc.Process != nil {
		status.PID = serveProc.Process.Pid
	}
	return status
}

// StartServe spawns llama-server against the given model. Returns
// immediately; log lines stream over deploy:serve-log and state
// changes over deploy:serve-status.
//
// ctxSize controls the llama-server --ctx-size flag (max tokens).
// Pass 0 for the safe default 4096. nGpuLayers controls --n-gpu-layers
// (number of transformer layers offloaded to GPU). Pass -1 for 999
// (offload everything; llama-server clamps to the actual count).
func (a *App) StartServe(modelID, quant string, ctxSize, nGpuLayers int) error {
	serveMu.Lock()
	if serveProc != nil {
		serveMu.Unlock()
		return fmt.Errorf("llama-server is already running for %s — stop it first", serveModel)
	}
	serveMu.Unlock()

	model, err := catalog.Get(modelID)
	if err != nil {
		return err
	}
	fileName, ok := model.QuantFiles()[quant]
	if !ok {
		return fmt.Errorf("model %s has no %s GGUF in our catalog", modelID, quant)
	}
	modelPath, err := paths.ModelFile(modelID, fileName)
	if err != nil {
		return err
	}
	if _, err := os.Stat(modelPath); err != nil {
		return fmt.Errorf("model GGUF not on disk: %s\n  pull it first", modelPath)
	}

	bin, err := runtime.Find()
	if err != nil {
		return fmt.Errorf("%w\n\n%s", err, runtime.InstallInstructions())
	}

	if ctxSize <= 0 {
		ctxSize = 4096
	}
	if nGpuLayers < 0 {
		nGpuLayers = 999
	}

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, bin,
		"--model", modelPath,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(servePort),
		"--api-key", localAPIKey,
		"--ctx-size", strconv.Itoa(ctxSize),
		"--n-gpu-layers", strconv.Itoa(nGpuLayers),
	)
	hideConsole(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start: %w", err)
	}

	serveMu.Lock()
	serveProc = cmd
	serveCancel = cancel
	serveState = "starting"
	serveModel = modelID
	serveQuant = quant
	serveMu.Unlock()

	a.emitServerStatus()

	// Fan stdout + stderr lines into the deploy:serve-log event stream.
	go pipeLines(a, stdout)
	go pipeLines(a, stderr)

	// Poll /health until ready, then flip state to running.
	go func() {
		if waitForReady(ctx, servePort, 60*time.Second) {
			serveMu.Lock()
			serveState = "running"
			serveMu.Unlock()
			a.emitServerStatus()
		}
	}()

	// Reap the subprocess when it exits — clears the state so the
	// next StartServe call can proceed.
	go func() {
		_ = cmd.Wait()
		serveMu.Lock()
		serveProc = nil
		serveCancel = nil
		serveState = "stopped"
		serveModel = ""
		serveQuant = ""
		serveMu.Unlock()
		a.emitServerStatus()
	}()

	return nil
}

// StopServe terminates the supervised llama-server process. Returns nil
// if nothing was running.
func (a *App) StopServe() error {
	serveMu.Lock()
	defer serveMu.Unlock()
	if serveProc == nil {
		return nil
	}
	if serveCancel != nil {
		serveCancel()
	}
	if serveProc.Process != nil {
		// SIGTERM first; the cancel context will SIGKILL via
		// CommandContext if it doesn't exit.
		_ = serveProc.Process.Signal(syscall.SIGTERM)
	}
	return nil
}

func (a *App) emitServerStatus() {
	st := a.ServerStatus()
	wailsruntime.EventsEmit(a.ctx, "deploy:serve-status", st)
}

func pipeLines(a *App, r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		wailsruntime.EventsEmit(a.ctx, "deploy:serve-log",
			map[string]string{"line": scanner.Text()})
	}
}

// waitForReady polls /health on the supervised llama-server until it
// answers 200, the timeout fires, or the context is canceled.
func waitForReady(ctx context.Context, port int, timeout time.Duration) bool {
	url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return false
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err == nil {
			req.Header.Set("Authorization", "Bearer "+localAPIKey)
			resp, err := http.DefaultClient.Do(req)
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					return true
				}
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(500 * time.Millisecond):
		}
	}
	return false
}

// _ = filepath used in stat path printing (keeps the import if other
// helpers grow later); silences staticcheck if Phase 4.x grows.
var _ = filepath.Base
