// Python runtime IPC — drives the optional Python features (LoRA
// training, vLLM, TensorRT-LLM, LLMLingua) from the Dashboard.
//
// User flow:
//
//   1. Open Dashboard, scroll to "Python runtime" card.
//   2. See list of optional features with size + GPU requirement.
//   3. Click "Install" on one (or several). Backend serialises them.
//   4. Watch progress events stream as uv downloads + installs.
//   5. Done. Feature is now usable.
//
// Long-running install runs in a goroutine; the UI listens for
// pyruntime:install-progress events and reads PythonRuntimeStatus()
// to know when the install lands.

package main

import (
	"context"
	"errors"
	"fmt"
	"sync"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/inspireailab-admin/blueprint-app/internal/pyruntime"
)

// PythonFeatureStatus is what the frontend renders per feature.
type PythonFeatureStatus struct {
	pyruntime.Feature
	Installed     bool   `json:"installed"`
	InstalledAtMs int64  `json:"installedAtMs,omitempty"`
}

// PythonRuntimeStatus is the umbrella status the Dashboard card reads.
type PythonRuntimeStatus struct {
	UvPresent     bool                   `json:"uvPresent"`
	UvPath        string                 `json:"uvPath"`
	UvDownloadURL string                 `json:"uvDownloadURL"`
	RuntimeDir    string                 `json:"runtimeDir"`
	Disk          pyruntime.DiskInfo     `json:"disk"`
	Features      []PythonFeatureStatus  `json:"features"`
	InstallInFlight string               `json:"installInFlight,omitempty"`
}

// installMu serializes installs across the process.
var installMu sync.Mutex
var inFlight string

// ListPythonFeatures returns the catalog. Pure data, no I/O.
func (a *App) ListPythonFeatures() []pyruntime.Feature {
	return pyruntime.All()
}

// PythonRuntimeStatus reports the combined state — what's installed,
// how much room there is, where the runtime lives.
func (a *App) PythonRuntimeStatus() PythonRuntimeStatus {
	st := PythonRuntimeStatus{
		UvPresent:     pyruntime.UvPresent(),
		UvDownloadURL: pyruntime.UvDownloadURL(),
	}
	if p, err := pyruntime.UvPath(); err == nil {
		st.UvPath = p
	}
	if d, err := pyruntime.RuntimeDir(); err == nil {
		st.RuntimeDir = d
	}
	if info, err := pyruntime.QueryDisk(); err == nil {
		st.Disk = info
	}
	manifest, _ := pyruntime.LoadManifest()
	installedByID := map[string]int64{}
	if manifest != nil {
		for _, f := range manifest.Features {
			installedByID[f.ID] = f.InstalledAtMs
		}
	}
	for _, f := range pyruntime.All() {
		st.Features = append(st.Features, PythonFeatureStatus{
			Feature:       f,
			Installed:     installedByID[f.ID] != 0,
			InstalledAtMs: installedByID[f.ID],
		})
	}
	installMu.Lock()
	st.InstallInFlight = inFlight
	installMu.Unlock()
	return st
}

// InstallPythonFeature kicks off (1) uv download if missing,
// (2) Python core bootstrap if not yet done, (3) pip install for the
// feature's packages + every transitive dependency.
//
// Returns immediately. Progress streams over pyruntime:install-progress
// events. Completion shows up in PythonRuntimeStatus via the Installed
// flag flipping true on the manifest.
func (a *App) InstallPythonFeature(featureID string) error {
	feature := pyruntime.Get(featureID)
	if feature == nil {
		return fmt.Errorf("unknown feature %q", featureID)
	}
	installMu.Lock()
	if inFlight != "" {
		busy := inFlight
		installMu.Unlock()
		return fmt.Errorf("another install is in flight: %s", busy)
	}
	inFlight = featureID
	installMu.Unlock()

	go a.runInstall(featureID)
	return nil
}

func (a *App) runInstall(featureID string) {
	defer func() {
		installMu.Lock()
		inFlight = ""
		installMu.Unlock()
		a.emitInstall(featureID, "done", "")
	}()

	ctx := context.Background()
	onLine := func(line string) {
		a.emitInstall(featureID, "log", line)
	}

	// 1. uv binary.
	if !pyruntime.UvPresent() {
		a.emitInstall(featureID, "stage", "downloading uv")
		err := pyruntime.DownloadUv(ctx, func(done, total int64) {
			a.emitInstallProgress(featureID, done, total, "downloading uv")
		})
		if err != nil {
			a.emitInstall(featureID, "error", "download uv: "+err.Error())
			return
		}
	}

	// 2. Resolve dependencies. Skip ones already installed.
	chain := pyruntime.ResolveDependencies(featureID)
	for _, f := range chain {
		if pyruntime.IsInstalled(f.ID) {
			continue
		}
		a.emitInstall(featureID, "stage", "installing "+f.Name)

		if f.ID == pyruntime.FeaturePythonCore {
			if err := pyruntime.EnsureCorePackages(ctx, onLine); err != nil {
				a.emitInstall(featureID, "error", "python core: "+err.Error())
				return
			}
		}

		if err := pyruntime.InstallPipPackages(ctx, f.PipPackages, f.IndexURL, onLine); err != nil {
			a.emitInstall(featureID, "error", f.ID+": "+err.Error())
			return
		}

		if err := pyruntime.MarkInstalled(f.ID); err != nil {
			a.emitInstall(featureID, "error", "manifest: "+err.Error())
			return
		}
	}
}

// UninstallPythonFeature drops a feature's packages from the venv +
// removes it from the manifest. Dependencies survive — uninstalling
// "vllm" doesn't drop PyTorch since LoRA training might still need it.
func (a *App) UninstallPythonFeature(featureID string) error {
	feature := pyruntime.Get(featureID)
	if feature == nil {
		return fmt.Errorf("unknown feature %q", featureID)
	}
	installMu.Lock()
	if inFlight != "" {
		busy := inFlight
		installMu.Unlock()
		return fmt.Errorf("another install is in flight: %s", busy)
	}
	inFlight = featureID
	installMu.Unlock()

	go func() {
		defer func() {
			installMu.Lock()
			inFlight = ""
			installMu.Unlock()
			a.emitInstall(featureID, "done", "")
		}()

		ctx := context.Background()
		onLine := func(line string) {
			a.emitInstall(featureID, "log", line)
		}
		a.emitInstall(featureID, "stage", "uninstalling "+feature.Name)
		if err := pyruntime.UninstallPipPackages(ctx, feature.PipPackages, onLine); err != nil {
			// Non-fatal: pip uninstall can warn about packages not
			// installed; we still want to drop the manifest entry.
			a.emitInstall(featureID, "log", "uninstall warning: "+err.Error())
		}
		if err := pyruntime.MarkUninstalled(featureID); err != nil {
			a.emitInstall(featureID, "error", "manifest: "+err.Error())
			return
		}
	}()

	return nil
}

// CheckDiskSpaceFor estimates whether the requested features fit. Returns
// the marginal sum and the free space; UI does the comparison + renders
// the warning.
type DiskSpaceCheck struct {
	RequestedBytes int64              `json:"requestedBytes"`
	Disk           pyruntime.DiskInfo `json:"disk"`
	Feasible       bool               `json:"feasible"`
}

// CheckPythonFeatureDiskSpace sums the marginal sizes of every
// not-yet-installed feature in the dependency chain and compares to
// free disk space. Returns Feasible=false when the user doesn't have
// room with at least 10% headroom over the requested size.
func (a *App) CheckPythonFeatureDiskSpace(featureID string) (DiskSpaceCheck, error) {
	feature := pyruntime.Get(featureID)
	if feature == nil {
		return DiskSpaceCheck{}, fmt.Errorf("unknown feature %q", featureID)
	}
	var sum int64
	for _, f := range pyruntime.ResolveDependencies(featureID) {
		if !pyruntime.IsInstalled(f.ID) {
			sum += f.AddedSizeBytes
		}
	}
	disk, err := pyruntime.QueryDisk()
	if err != nil {
		return DiskSpaceCheck{RequestedBytes: sum}, err
	}
	required := uint64(sum) + uint64(sum)/10 // 10% headroom
	return DiskSpaceCheck{
		RequestedBytes: sum,
		Disk:           disk,
		Feasible:       disk.FreeBytes >= required,
	}, nil
}

// ─── Event helpers ────────────────────────────────────────────────────────

func (a *App) emitInstall(featureID, stage, detail string) {
	wailsruntime.EventsEmit(a.ctx, "pyruntime:install-progress",
		map[string]string{"featureId": featureID, "stage": stage, "detail": detail})
}

func (a *App) emitInstallProgress(featureID string, done, total int64, stage string) {
	wailsruntime.EventsEmit(a.ctx, "pyruntime:install-progress",
		map[string]any{
			"featureId": featureID,
			"stage":     stage,
			"done":      done,
			"total":     total,
		})
}

var _ = errors.New // keep errors import live for future expansion
