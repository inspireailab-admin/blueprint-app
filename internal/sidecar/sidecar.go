// Package sidecar manages Blueprint's Python sidecar processes — the
// helper services that wrap libraries like LLMLingua and (later) the
// LoRA training pipeline. Each sidecar is a tiny FastAPI server
// supervised the same way we supervise llama-server.
//
// Two responsibilities:
//
//   1. Embed the Python source for each sidecar via go:embed and write
//      it to disk on first use, under ~/.blueprint/python/sidecar/.
//      Caller invokes ExtractAll() right after the pyruntime venv is
//      ready.
//
//   2. Spawn + supervise the process. Supervise() returns a handle the
//      app holds onto; closing it kills the child.
//
// HTTP for IPC, localhost ports in a fixed range so the sidecars and
// llama-server don't collide.

package sidecar

import (
	"context"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/pyruntime"
	"github.com/inspireailab-admin/blueprint/pkg/paths"
)

//go:embed compress.py train.py
var srcFS embed.FS

// ExtractAll writes the embedded Python files to disk under
// ~/.blueprint/python/sidecar/. Idempotent — overwrites existing
// files so an upgraded Blueprint always ships its current sidecar
// code.
func ExtractAll() error {
	dst, err := SidecarDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := fs.ReadDir(srcFS, ".")
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := fs.ReadFile(srcFS, e.Name())
		if err != nil {
			return err
		}
		out := filepath.Join(dst, e.Name())
		if err := os.WriteFile(out, data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// SidecarDir is where extracted Python files live.
func SidecarDir() (string, error) {
	root, err := paths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "python", "sidecar"), nil
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

// Sidecar wraps one running Python child. Created by Spawn, closed by
// Stop.
type Sidecar struct {
	Name string
	Port int

	cmd        *exec.Cmd
	cancel     context.CancelFunc
	mu         sync.Mutex
	logFile    *os.File
	healthURL  string
}

// Spawn starts a Python sidecar script in the managed venv. scriptName
// is the basename ("compress.py"); extraArgs are forwarded after the
// port arg.
//
// Returns a Sidecar that the caller is responsible for stopping. The
// caller is also responsible for ExtractAll() having run beforehand.
func Spawn(scriptName string, extraArgs []string) (*Sidecar, error) {
	if err := ExtractAll(); err != nil {
		return nil, fmt.Errorf("extract sidecar source: %w", err)
	}
	dir, err := SidecarDir()
	if err != nil {
		return nil, err
	}
	scriptPath := filepath.Join(dir, scriptName)
	if _, err := os.Stat(scriptPath); err != nil {
		return nil, fmt.Errorf("sidecar script missing: %s", scriptPath)
	}

	pythonBin, err := pyruntime.VenvPython()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(pythonBin); err != nil {
		return nil, fmt.Errorf("python not installed in venv (%s) — install Python core via the Dashboard's Python runtime card", pythonBin)
	}

	port, err := pickPort()
	if err != nil {
		return nil, err
	}

	logsDir := filepath.Join(dir, "logs")
	_ = os.MkdirAll(logsDir, 0o755)
	logPath := filepath.Join(logsDir, scriptName+".log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open sidecar log: %w", err)
	}

	args := append([]string{scriptPath, strconv.Itoa(port)}, extraArgs...)
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, pythonBin, args...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		cancel()
		return nil, fmt.Errorf("start sidecar %s: %w", scriptName, err)
	}

	s := &Sidecar{
		Name:      scriptName,
		Port:      port,
		cmd:       cmd,
		cancel:    cancel,
		logFile:   logFile,
		healthURL: fmt.Sprintf("http://127.0.0.1:%d/health", port),
	}

	// Detach the supervision goroutine; when the child exits unexpectedly,
	// we just close the log file and let the caller's next op fail with a
	// clear "sidecar not running" error.
	go func() {
		_ = cmd.Wait()
		s.mu.Lock()
		if s.logFile != nil {
			_ = s.logFile.Close()
			s.logFile = nil
		}
		s.mu.Unlock()
	}()

	return s, nil
}

// WaitHealthy blocks until /health returns 200 or the timeout fires.
// Used by callers right after Spawn to know the FastAPI server is up.
func (s *Sidecar) WaitHealthy(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		req, err := http.NewRequest(http.MethodGet, s.healthURL, nil)
		if err == nil {
			client := &http.Client{Timeout: 1 * time.Second}
			resp, err := client.Do(req)
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					return nil
				}
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("sidecar %s did not become healthy in %s", s.Name, timeout)
}

// Stop kills the sidecar process. Idempotent.
func (s *Sidecar) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	s.mu.Lock()
	if s.logFile != nil {
		_ = s.logFile.Close()
		s.logFile = nil
	}
	s.mu.Unlock()
}

// BaseURL returns the http://127.0.0.1:port root the sidecar serves.
func (s *Sidecar) BaseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", s.Port)
}

// ─── Port allocation ──────────────────────────────────────────────────────

// pickPort walks 19150..19299 looking for one we can bind. The range
// is intentionally above the eval harness's 17150..17300 and below
// any well-known service.
func pickPort() (int, error) {
	for p := 19150; p <= 19299; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			ln.Close()
			return p, nil
		}
	}
	return 0, fmt.Errorf("no free sidecar port in 19150..19299")
}

// Drain copies the entire body to /dev/null + closes — common helper.
func Drain(r io.Reader, c io.Closer) {
	_, _ = io.Copy(io.Discard, r)
	if c != nil {
		_ = c.Close()
	}
}
