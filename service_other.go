//go:build !windows

// Non-Windows stubs for the Service IPC surface. Blueprint targets
// Windows as the supported corporate platform — macOS / Linux builds
// keep these methods callable so the bindings generate cleanly, but
// they all return "not implemented on this platform."
//
// Author: Amar Mond.
package main

import (
	"errors"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

// ServiceInfo mirrors the Windows ServiceInfo shape so the Wails generator
// emits the same TypeScript model on every platform — non-Windows builds
// always return the zero value.
type ServiceInfo struct {
	Installed      bool   `json:"installed"`
	SCMState       string `json:"scmState"`
	ExePath        string `json:"exePath,omitempty"`
	Phase          string `json:"phase,omitempty"`
	ModelID        string `json:"modelId,omitempty"`
	Quant          string `json:"quant,omitempty"`
	PID            int    `json:"pid,omitempty"`
	Port           int    `json:"port,omitempty"`
	BindHost       string `json:"bindHost,omitempty"`
	StartedAtMs    int64  `json:"startedAtMs,omitempty"`
	RestartCount   int    `json:"restartCount,omitempty"`
	LastError      string `json:"lastError,omitempty"`
	SvcBinExpected string `json:"svcBinExpected"`
	SvcBinPresent  bool   `json:"svcBinPresent"`
}

// ServeConfigInput mirrors the Windows ServeConfigInput shape — see the
// _windows variant for field documentation.
type ServeConfigInput struct {
	ModelID       string  `json:"modelId"`
	Quant         string  `json:"quant"`
	BindHost      string  `json:"bindHost"`
	Port          int     `json:"port"`
	CtxSize       int     `json:"ctxSize"`
	NGpuLayers    int     `json:"nGpuLayers"`
	Threads       int     `json:"threads,omitempty"`
	BatchSize     int     `json:"batchSize,omitempty"`
	UBatchSize    int     `json:"uBatchSize,omitempty"`
	FlashAttn     bool    `json:"flashAttn,omitempty"`
	MemoryLock    bool    `json:"memoryLock,omitempty"`
	NoMmap        bool    `json:"noMmap,omitempty"`
	ParallelSlots int     `json:"parallelSlots,omitempty"`
	ContBatching  bool    `json:"contBatching,omitempty"`
	KvCacheTypeK  string  `json:"kvCacheTypeK,omitempty"`
	KvCacheTypeV  string  `json:"kvCacheTypeV,omitempty"`
	LogVerbose    bool    `json:"logVerbose,omitempty"`
	LoraAdapter   string  `json:"loraAdapter,omitempty"`
	LoraScale     float64 `json:"loraScale,omitempty"`
	Engine        string  `json:"engine,omitempty"`
	ModelPathOverride string `json:"modelPathOverride,omitempty"`
}

// LoraAdapterEntry mirrors the Windows LoraAdapterEntry shape — see the
// _windows variant for field documentation.
type LoraAdapterEntry struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	SizeBytes int64  `json:"sizeBytes"`
}

var errNotWindows = errors.New("Blueprint Service is only available on Windows in this release")

// ServiceInfo returns an empty ServiceInfo on non-Windows builds (the
// service is Windows-only in this release).
func (a *App) ServiceInfo() ServiceInfo {
	return ServiceInfo{}
}

// InstallService is unavailable on non-Windows builds. Returns errNotWindows.
func (a *App) InstallService() error                   { return errNotWindows }
// UninstallService is unavailable on non-Windows builds. Returns errNotWindows.
func (a *App) UninstallService() error                 { return errNotWindows }
// StartManagedServer is unavailable on non-Windows builds. Returns errNotWindows.
func (a *App) StartManagedServer() error               { return errNotWindows }
// StopManagedServer is unavailable on non-Windows builds. Returns errNotWindows.
func (a *App) StopManagedServer() error                { return errNotWindows }
// RestartManagedServer is unavailable on non-Windows builds. Returns errNotWindows.
func (a *App) RestartManagedServer() error             { return errNotWindows }
// ApplyServeConfig is unavailable on non-Windows builds. Returns errNotWindows.
func (a *App) ApplyServeConfig(in ServeConfigInput) error { return errNotWindows }
// CurrentServeConfig is unavailable on non-Windows builds. Returns nil.
func (a *App) CurrentServeConfig() *svcconfig.Config   { return nil }
// ListLoraAdapters is unavailable on non-Windows builds. Returns errNotWindows.
func (a *App) ListLoraAdapters() ([]LoraAdapterEntry, error) { return nil, errNotWindows }
