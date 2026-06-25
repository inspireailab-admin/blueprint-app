//go:build windows

// Service IPC surface — the desktop app's bridge to the Windows
// Service that supervises llama-server.
//
// What lives here:
//
//   ServiceInfo()        ← combined SCM + supervisor view
//   InstallService()     ← spawn blueprint-svc.exe via UAC ("runas")
//   UninstallService()   ← same path, "uninstall" subcommand
//   ApplyServeConfig()   ← writes service-config.json + restarts SCM
//   StartManagedServer() ← SCM start
//   StopManagedServer()  ← SCM stop
//
// All require Windows. The build tag keeps this file out of macOS /
// Linux builds; service_other.go provides stubs there so the App
// struct exposes the same methods regardless.

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
	"github.com/inspireailab-admin/blueprint/pkg/catalog"
	"github.com/inspireailab-admin/blueprint/pkg/paths"
	bpruntime "github.com/inspireailab-admin/blueprint/pkg/runtime"
)

// ServiceInfo combines the SCM-level view (installed? running?) with
// the supervisor-level view (what's the child doing right now?). The
// Dashboard renders both in one card so the user has the full picture.
type ServiceInfo struct {
	// Installed is true if there's a service registered with SCM under
	// our name. False means the user hasn't run "Install service" yet.
	Installed bool `json:"installed"`

	// SCMState mirrors the Windows service state machine:
	// "stopped" | "start_pending" | "running" | "stop_pending" | "unknown".
	SCMState string `json:"scmState"`

	// ExePath is where SCM thinks our service binary lives.
	ExePath string `json:"exePath,omitempty"`

	// Phase is the supervisor's self-reported state:
	// "idle" | "running" | "crashed" | "stopped".
	Phase string `json:"phase,omitempty"`

	// ModelID + Quant of the currently-serving child (if any).
	ModelID string `json:"modelId,omitempty"`
	Quant   string `json:"quant,omitempty"`

	// PID + Port of the llama-server child.
	PID  int `json:"pid,omitempty"`
	Port int `json:"port,omitempty"`

	// BindHost is what llama-server's --host is. 127.0.0.1 = local,
	// 0.0.0.0 = LAN-visible.
	BindHost string `json:"bindHost,omitempty"`

	// StartedAtMs is when the child was last spawned.
	StartedAtMs int64 `json:"startedAtMs,omitempty"`

	// RestartCount is how many times the supervisor has had to bring
	// the child back since service start.
	RestartCount int `json:"restartCount,omitempty"`

	// LastError, when non-empty, is the most recent supervisor or
	// child error.
	LastError string `json:"lastError,omitempty"`

	// SvcBinExpected is the path the app expects blueprint-svc.exe at —
	// next to blueprint.exe. UI uses this to surface "missing
	// blueprint-svc.exe" install errors clearly.
	SvcBinExpected string `json:"svcBinExpected"`

	// SvcBinPresent confirms the .exe is actually there. False blocks
	// the Install button with a clear "build the service binary first"
	// message.
	SvcBinPresent bool `json:"svcBinPresent"`
}

// ServiceInfo returns the combined SCM + supervisor view.
func (a *App) ServiceInfo() ServiceInfo {
	info := ServiceInfo{}

	// Locate the expected blueprint-svc.exe.
	if exePath, err := serviceBinPath(); err == nil {
		info.SvcBinExpected = exePath
		if _, err := os.Stat(exePath); err == nil {
			info.SvcBinPresent = true
		}
	}

	// SCM state.
	m, err := mgr.Connect()
	if err == nil {
		defer m.Disconnect()
		if s, err := m.OpenService(svcconfig.ServiceName); err == nil {
			info.Installed = true
			cfg, _ := s.Config()
			info.ExePath = cfg.BinaryPathName
			if st, err := s.Query(); err == nil {
				info.SCMState = scmStateString(st.State)
			} else {
				info.SCMState = "unknown"
			}
			s.Close()
		}
	}

	// Supervisor view from the on-disk status file.
	if st, err := svcconfig.ReadStatus(); err == nil && st != nil {
		info.Phase = st.Phase
		info.ModelID = st.ModelID
		info.Quant = st.Quant
		info.PID = st.PID
		info.Port = st.Port
		info.BindHost = st.BindHost
		info.StartedAtMs = st.StartedAtMs
		info.RestartCount = st.RestartCount
		info.LastError = st.LastError
	}

	return info
}

// InstallService kicks off `blueprint-svc.exe install` via UAC. Returns
// once ShellExecute returns — i.e., the user has either accepted or
// rejected the elevation prompt. The actual install proceeds in the
// elevated child; the Dashboard polls ServiceInfo to see when it
// becomes Installed.
func (a *App) InstallService() error {
	exePath, err := serviceBinPath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(exePath); err != nil {
		return fmt.Errorf("blueprint-svc.exe not found at %s — build it first (build.ps1)", exePath)
	}
	return shellExecuteElevated(exePath, "install")
}

// UninstallService kicks off `blueprint-svc.exe uninstall` via UAC.
func (a *App) UninstallService() error {
	exePath, err := serviceBinPath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(exePath); err != nil {
		return fmt.Errorf("blueprint-svc.exe not found at %s", exePath)
	}
	return shellExecuteElevated(exePath, "uninstall")
}

// StartManagedServer asks SCM to start the service. The supervisor
// inside the service then reads service-config.json and spawns
// llama-server with it. Caller is expected to have written a sensible
// config first via ApplyServeConfig.
func (a *App) StartManagedServer() error {
	return scmControl(scmStart)
}

// StopManagedServer asks SCM to stop the service. The supervisor
// kills its child llama-server cleanly within a few seconds.
func (a *App) StopManagedServer() error {
	return scmControl(scmStop)
}

// RestartManagedServer is stop + start — used after the user changes
// the config (model, quant, ctx size, bind, GPU layers).
func (a *App) RestartManagedServer() error {
	if err := scmControl(scmStop); err != nil {
		// Failure to stop is usually because it wasn't running.
	}
	// Wait briefly for it to actually transition.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if info := a.ServiceInfo(); info.SCMState == "stopped" || info.SCMState == "" {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	return scmControl(scmStart)
}

// ServeConfigInput is what the Dashboard passes to set the supervisor's
// desired state.
type ServeConfigInput struct {
	ModelID    string `json:"modelId"`
	Quant      string `json:"quant"`
	BindHost   string `json:"bindHost"`
	Port       int    `json:"port"`
	CtxSize    int    `json:"ctxSize"`
	NGpuLayers int    `json:"nGpuLayers"`
}

// ApplyServeConfig validates the input, resolves the absolute paths
// the supervisor will need (llama-server binary, GGUF), generates an
// API key on first call, and writes service-config.json. Caller is
// expected to follow with RestartManagedServer to make the supervisor
// actually pick up the change.
func (a *App) ApplyServeConfig(in ServeConfigInput) error {
	if in.ModelID == "" || in.Quant == "" {
		return errors.New("model and quant are required")
	}
	model, err := catalog.Get(in.ModelID)
	if err != nil {
		return err
	}
	fileName, ok := model.QuantFiles()[in.Quant]
	if !ok {
		return fmt.Errorf("no %s GGUF for model %s", in.Quant, in.ModelID)
	}
	modelPath, err := paths.ModelFile(in.ModelID, fileName)
	if err != nil {
		return err
	}
	if _, err := os.Stat(modelPath); err != nil {
		return fmt.Errorf("model GGUF not on disk: %s — pull it first", modelPath)
	}
	bin, err := bpruntime.Find()
	if err != nil {
		return fmt.Errorf("runtime not installed: %w", err)
	}

	host := in.BindHost
	if host == "" {
		host = "127.0.0.1"
	}
	if host != "127.0.0.1" && host != "0.0.0.0" {
		return fmt.Errorf("bindHost must be 127.0.0.1 or 0.0.0.0, got %q", host)
	}
	port := in.Port
	if port <= 0 {
		port = 8080
	}
	ctxSize := in.CtxSize
	if ctxSize <= 0 {
		ctxSize = 4096
	}
	nGpu := in.NGpuLayers
	if nGpu < 0 {
		nGpu = 999
	}

	// Preserve the existing API key if there's one — the chat panel
	// has it pinned. Only generate a fresh one on first install.
	apiKey := ""
	if prev, err := svcconfig.ReadConfig(); err == nil && prev != nil && prev.APIKey != "" {
		apiKey = prev.APIKey
	} else {
		apiKey, err = randomToken(24)
		if err != nil {
			return fmt.Errorf("generate api key: %w", err)
		}
	}

	cfg := svcconfig.Config{
		LlamaServerBin: bin,
		ModelPath:      modelPath,
		ModelID:        in.ModelID,
		Quant:          in.Quant,
		BindHost:       host,
		Port:           port,
		APIKey:         apiKey,
		CtxSize:        ctxSize,
		NGpuLayers:     nGpu,
		EnableMetrics:  true,
		MaxRestarts:    0, // unbounded — corporate uptime
		UpdatedAt:      time.Now().UnixMilli(),
	}
	return svcconfig.WriteConfig(cfg)
}

// CurrentServeConfig surfaces the desired-state config so the
// Dashboard can render "currently configured for: Qwen 7B Q4 @ 4096
// ctx" even when the service is stopped.
func (a *App) CurrentServeConfig() *svcconfig.Config {
	c, _ := svcconfig.ReadConfig()
	return c
}

// ─── Internals ─────────────────────────────────────────────────────────────

// serviceBinPath returns the path where blueprint-svc.exe is expected
// to live — same directory as the running blueprint.exe.
func serviceBinPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(exe), "blueprint-svc.exe"), nil
}

// shellExecuteElevated runs an executable via ShellExecute with the
// "runas" verb. This pops the UAC dialog; on accept, the child runs
// with admin token. On reject, returns an error.
//
// Doesn't capture stdout — UAC-elevated children get their own
// console. The desktop app's caller is expected to poll for
// completion (e.g., ServiceInfo().Installed transitioning to true).
func shellExecuteElevated(exe, args string) error {
	verb, err := windows.UTF16PtrFromString("runas")
	if err != nil {
		return err
	}
	exePtr, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return err
	}
	var argsPtr *uint16
	if args != "" {
		argsPtr, err = windows.UTF16PtrFromString(args)
		if err != nil {
			return err
		}
	}
	cwdPtr, err := windows.UTF16PtrFromString(filepath.Dir(exe))
	if err != nil {
		return err
	}
	// ShowCmd 1 = SW_NORMAL.
	if err := windows.ShellExecute(0, verb, exePtr, argsPtr, cwdPtr, 1); err != nil {
		return fmt.Errorf("UAC elevation declined or failed: %w", err)
	}
	return nil
}

type scmCmd int

const (
	scmStart scmCmd = iota
	scmStop
)

func scmControl(cmd scmCmd) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcconfig.ServiceName)
	if err != nil {
		return fmt.Errorf("service not installed: %w", err)
	}
	defer s.Close()
	switch cmd {
	case scmStart:
		return s.Start()
	case scmStop:
		_, err := s.Control(svc.Stop)
		return err
	}
	return nil
}

func scmStateString(state svc.State) string {
	switch state {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start_pending"
	case svc.StopPending:
		return "stop_pending"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continue_pending"
	case svc.PausePending:
		return "pause_pending"
	case svc.Paused:
		return "paused"
	default:
		return "unknown"
	}
}

func randomToken(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Silence unused imports if a future change drops some.
var (
	_ = exec.Command
	_ = strings.Split
	_ = unsafe.Pointer(nil)
)
