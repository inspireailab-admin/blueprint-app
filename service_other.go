//go:build !windows

// Non-Windows stubs for the Service IPC surface. Blueprint targets
// Windows as the supported corporate platform — macOS / Linux builds
// keep these methods callable so the bindings generate cleanly, but
// they all return "not implemented on this platform."

package main

import (
	"errors"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

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

type ServeConfigInput struct {
	ModelID    string `json:"modelId"`
	Quant      string `json:"quant"`
	BindHost   string `json:"bindHost"`
	Port       int    `json:"port"`
	CtxSize    int    `json:"ctxSize"`
	NGpuLayers int    `json:"nGpuLayers"`
}

var errNotWindows = errors.New("Blueprint Service is only available on Windows in this release")

func (a *App) ServiceInfo() ServiceInfo {
	return ServiceInfo{}
}

func (a *App) InstallService() error                   { return errNotWindows }
func (a *App) UninstallService() error                 { return errNotWindows }
func (a *App) StartManagedServer() error               { return errNotWindows }
func (a *App) StopManagedServer() error                { return errNotWindows }
func (a *App) RestartManagedServer() error             { return errNotWindows }
func (a *App) ApplyServeConfig(in ServeConfigInput) error { return errNotWindows }
func (a *App) CurrentServeConfig() *svcconfig.Config   { return nil }
