//go:build windows

// Service IPC surface â€” the desktop app's bridge to the Windows
// Service that supervises llama-server.
//
// What lives here:
//
//   ServiceInfo()        â† combined SCM + supervisor view
//   InstallService()     â† spawn blueprint-svc.exe via UAC ("runas")
//   UninstallService()   â† same path, "uninstall" subcommand
//   ApplyServeConfig()   â† writes service-config.json + restarts SCM
//   StartManagedServer() â† SCM start
//   StopManagedServer()  â† SCM stop
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
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
	"github.com/inspireailab-admin/blueprint-cli/pkg/catalog"
	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"
	bpruntime "github.com/inspireailab-admin/blueprint-cli/pkg/runtime"
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

	// SvcBinExpected is the path the app expects blueprint-svc.exe at â€”
	// next to blueprint.exe. UI uses this to surface "missing
	// blueprint-svc.exe" install errors clearly.
	SvcBinExpected string `json:"svcBinExpected"`

	// SvcBinPresent confirms the .exe is actually there. False blocks
	// the Install button with a clear "build the service binary first"
	// message.
	SvcBinPresent bool `json:"svcBinPresent"`
}

// ServiceInfo returns the combined SCM + supervisor view.
//
// CRITICAL: This runs in the desktop app, which is launched by the
// interactive user â€” not an administrator. The golang.org/x/sys
// /windows/svc/mgr package's Connect() opens the SCM with
// SC_MANAGER_ALL_ACCESS, which a non-admin user can't get; the
// call fails silently and the app falsely reports "not installed."
// We bypass mgr.Connect entirely and call windows.OpenSCManager
// directly with SC_MANAGER_CONNECT, which any authenticated user
// can do â€” enough to query service state.
func (a *App) ServiceInfo() ServiceInfo {
	info := ServiceInfo{}

	if exePath, err := serviceBinPath(); err == nil {
		info.SvcBinExpected = exePath
		if _, err := os.Stat(exePath); err == nil {
			info.SvcBinPresent = true
		}
	}

	state, exePath, err := querySCMState()
	if err == nil {
		info.Installed = true
		info.SCMState = state
		info.ExePath = exePath
	}

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

// querySCMState opens the service handle with the lowest possible
// access flags so it works from a non-elevated process. Returns
// (state, binaryPath, error) â€” error is set only when the service
// is missing or the SCM is unreachable.
func querySCMState() (string, string, error) {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return "", "", fmt.Errorf("open SCM: %w", err)
	}
	defer windows.CloseServiceHandle(scm)

	namePtr, err := windows.UTF16PtrFromString(svcconfig.ServiceName)
	if err != nil {
		return "", "", err
	}
	svcHandle, err := windows.OpenService(scm, namePtr,
		windows.SERVICE_QUERY_STATUS|windows.SERVICE_QUERY_CONFIG)
	if err != nil {
		return "", "", fmt.Errorf("open service: %w", err)
	}
	defer windows.CloseServiceHandle(svcHandle)

	var status windows.SERVICE_STATUS_PROCESS
	var needed uint32
	if err := windows.QueryServiceStatusEx(svcHandle, windows.SC_STATUS_PROCESS_INFO,
		(*byte)(unsafe.Pointer(&status)), uint32(unsafe.Sizeof(status)), &needed); err != nil {
		return "unknown", "", nil
	}

	// QueryServiceConfig with a sensible buffer to retrieve the binary
	// path. We don't actually need the path for correctness, just for
	// the UI to render the install location.
	binPath := ""
	bufSize := uint32(8192)
	buf := make([]byte, bufSize)
	if err := windows.QueryServiceConfig(svcHandle,
		(*windows.QUERY_SERVICE_CONFIG)(unsafe.Pointer(&buf[0])), bufSize, &needed); err == nil {
		cfg := (*windows.QUERY_SERVICE_CONFIG)(unsafe.Pointer(&buf[0]))
		if cfg.BinaryPathName != nil {
			binPath = windows.UTF16PtrToString(cfg.BinaryPathName)
		}
	}

	return scmStateFromCode(status.CurrentState), binPath, nil
}

func scmStateFromCode(state uint32) string {
	switch state {
	case windows.SERVICE_STOPPED:
		return "stopped"
	case windows.SERVICE_START_PENDING:
		return "start_pending"
	case windows.SERVICE_STOP_PENDING:
		return "stop_pending"
	case windows.SERVICE_RUNNING:
		return "running"
	case windows.SERVICE_CONTINUE_PENDING:
		return "continue_pending"
	case windows.SERVICE_PAUSE_PENDING:
		return "pause_pending"
	case windows.SERVICE_PAUSED:
		return "paused"
	default:
		return "unknown"
	}
}

// InstallService kicks off `blueprint-svc.exe install` via UAC. Returns
// once ShellExecute returns â€” i.e., the user has either accepted or
// rejected the elevation prompt. The actual install proceeds in the
// elevated child; the Dashboard polls ServiceInfo to see when it
// becomes Installed.
func (a *App) InstallService() error {
	exePath, err := serviceBinPath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(exePath); err != nil {
		return fmt.Errorf("blueprint-svc.exe not found at %s â€” build it first (build.ps1)", exePath)
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

// RestartManagedServer is stop + start â€” used after the user changes
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

	// Advanced startup params â€” all optional. Zero / empty values mean
	// "leave the llama.cpp default."
	Threads       int    `json:"threads,omitempty"`
	BatchSize     int    `json:"batchSize,omitempty"`
	UBatchSize    int    `json:"uBatchSize,omitempty"`
	FlashAttn     bool   `json:"flashAttn,omitempty"`
	MemoryLock    bool   `json:"memoryLock,omitempty"`
	NoMmap        bool   `json:"noMmap,omitempty"`
	ParallelSlots int    `json:"parallelSlots,omitempty"`
	ContBatching  bool   `json:"contBatching,omitempty"`
	KvCacheTypeK  string `json:"kvCacheTypeK,omitempty"`
	KvCacheTypeV  string `json:"kvCacheTypeV,omitempty"`
	LogVerbose    bool   `json:"logVerbose,omitempty"`

	// LoRA adapter to load on top of the base model. Empty = none.
	LoraAdapter string  `json:"loraAdapter,omitempty"`
	LoraScale   float64 `json:"loraScale,omitempty"`

	// Engine selects the inference runtime. Empty = llama-cpp (default).
	// Other valid values: "vllm" | "trt-llm" (only effective when the
	// corresponding Python feature is installed).
	Engine string `json:"engine,omitempty"`

	// ModelPathOverride lets engine-specific identifiers override the
	// catalog-resolved GGUF path. Used by vLLM (HF id) and TRT-LLM
	// (engine plan directory). When empty we resolve from ModelID +
	// Quant against the catalog like before.
	ModelPathOverride string `json:"modelPathOverride,omitempty"`
}

// LoraAdapterEntry is one .gguf/.bin LoRA adapter discovered on disk.
// Adapters live under ~/.blueprint/lora/ â€” the user drops trained
// files into that directory and the picker in ServiceCard surfaces
// them.
type LoraAdapterEntry struct {
	Path      string `json:"path"`
	Name      string `json:"name"`      // display name (file name minus .gguf)
	SizeBytes int64  `json:"sizeBytes"`
}

// ListLoraAdapters scans ~/.blueprint/lora/ for files that look like
// LoRA adapters (.gguf or .bin). Missing directory returns an empty
// slice, no error â€” the user just hasn't dropped any in yet.
func (a *App) ListLoraAdapters() ([]LoraAdapterEntry, error) {
	root, err := paths.Root()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(root, "lora")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]LoraAdapterEntry, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		lower := strings.ToLower(name)
		if !strings.HasSuffix(lower, ".gguf") && !strings.HasSuffix(lower, ".bin") {
			continue
		}
		full := filepath.Join(dir, name)
		info, _ := e.Info()
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		display := strings.TrimSuffix(strings.TrimSuffix(name, ".gguf"), ".bin")
		out = append(out, LoraAdapterEntry{
			Path:      full,
			Name:      display,
			SizeBytes: size,
		})
	}
	return out, nil
}

// ApplyServeConfig validates the input, resolves the absolute paths
// the supervisor will need (llama-server binary, GGUF), generates an
// API key on first call, and writes service-config.json. Caller is
// expected to follow with RestartManagedServer to make the supervisor
// actually pick up the change.
func (a *App) ApplyServeConfig(in ServeConfigInput) error {
	// When ModelPathOverride is set (vLLM HF identifier, TRT-LLM engine
	// plan dir), we trust it verbatim and skip the catalog. The local
	// catalog only knows about llama.cpp-flavored GGUFs.
	var modelPath string
	if in.ModelPathOverride != "" {
		modelPath = in.ModelPathOverride
	} else {
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
		modelPath, err = paths.ModelFile(in.ModelID, fileName)
		if err != nil {
			return err
		}
		if _, err := os.Stat(modelPath); err != nil {
			return fmt.Errorf("model GGUF not on disk: %s â€” pull it first", modelPath)
		}
	}

	// LlamaServerBin is preserved for back-compat with older configs.
	// The supervisor today resolves the binary via engines.Get(cfg.Engine).
	bin, err := bpruntime.Find()
	if err != nil && in.Engine == "" {
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

	// Preserve the existing API key if there's one â€” the chat panel
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

	// Validate KV cache types so the supervisor doesn't get a bad arg.
	if !validKvCacheType(in.KvCacheTypeK) {
		return fmt.Errorf("kvCacheTypeK must be empty, f16, q8_0, or q4_0; got %q", in.KvCacheTypeK)
	}
	if !validKvCacheType(in.KvCacheTypeV) {
		return fmt.Errorf("kvCacheTypeV must be empty, f16, q8_0, or q4_0; got %q", in.KvCacheTypeV)
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
		MaxRestarts:    0, // unbounded â€” corporate uptime
		UpdatedAt:      time.Now().UnixMilli(),
		// Advanced startup params, passed through verbatim.
		Threads:       in.Threads,
		BatchSize:     in.BatchSize,
		UBatchSize:    in.UBatchSize,
		FlashAttn:     in.FlashAttn,
		MemoryLock:    in.MemoryLock,
		NoMmap:        in.NoMmap,
		ParallelSlots: in.ParallelSlots,
		ContBatching:  in.ContBatching,
		KvCacheTypeK:  in.KvCacheTypeK,
		KvCacheTypeV:  in.KvCacheTypeV,
		LogVerbose:    in.LogVerbose,
		LoraAdapter:   in.LoraAdapter,
		LoraScale:     in.LoraScale,
		Engine:        in.Engine,
	}
	return svcconfig.WriteConfig(cfg)
}

func validKvCacheType(s string) bool {
	switch s {
	case "", "f16", "q8_0", "q4_0":
		return true
	}
	return false
}

// CurrentServeConfig surfaces the desired-state config so the
// Dashboard can render "currently configured for: Qwen 7B Q4 @ 4096
// ctx" even when the service is stopped.
func (a *App) CurrentServeConfig() *svcconfig.Config {
	c, _ := svcconfig.ReadConfig()
	return c
}

// â”€â”€â”€ Internals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// serviceBinPath returns the path where blueprint-svc.exe is expected
// to live â€” same directory as the running blueprint.exe.
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
// Doesn't capture stdout â€” UAC-elevated children get their own
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

// scmControl talks to SCM with the lowest-privilege access flags
// (SC_MANAGER_CONNECT + SERVICE_START/STOP|SERVICE_QUERY_STATUS) so
// it works for the interactive user â€” provided the service DACL was
// modified at install time to grant Authenticated Users start/stop
// rights. The installer (cmd/blueprint-svc/install_windows.go) does
// that via SetNamedSecurityInfo immediately after CreateService.
func scmControl(cmd scmCmd) error {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return fmt.Errorf("open SCM: %w", err)
	}
	defer windows.CloseServiceHandle(scm)

	namePtr, err := windows.UTF16PtrFromString(svcconfig.ServiceName)
	if err != nil {
		return err
	}

	var access uint32
	switch cmd {
	case scmStart:
		access = windows.SERVICE_START | windows.SERVICE_QUERY_STATUS
	case scmStop:
		access = windows.SERVICE_STOP | windows.SERVICE_QUERY_STATUS
	}
	svcHandle, err := windows.OpenService(scm, namePtr, access)
	if err != nil {
		return fmt.Errorf("open service: %w (is it installed? does your user have control rights?)", err)
	}
	defer windows.CloseServiceHandle(svcHandle)

	switch cmd {
	case scmStart:
		return windows.StartService(svcHandle, 0, nil)
	case scmStop:
		var status windows.SERVICE_STATUS
		return windows.ControlService(svcHandle, windows.SERVICE_CONTROL_STOP, &status)
	}
	return nil
}

func randomToken(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

var _ = unsafe.Pointer(nil) // satisfy linter; unsafe.Sizeof used above
