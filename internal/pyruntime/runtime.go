// Runtime state + persistence for the optional Python install.
//
// What we keep on disk under ~/.blueprint/python/:
//
//   features.json      â€” manifest of installed features (id + version + when)
//   uv.exe / uv         â€” the uv binary, downloaded on first install
//   python/             â€” uv-managed Python installation
//   venv/               â€” the venv we install all packages into
//   logs/               â€” install logs per attempt (for support)

package pyruntime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/disk"

	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"
)

// RuntimeDir returns the absolute path to ~/.blueprint/python/.
// Created on demand by callers that write into it.
func RuntimeDir() (string, error) {
	root, err := paths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "python"), nil
}

// UvPath returns where the uv binary lives. On Windows uv.exe, on
// other platforms just uv (no extension).
func UvPath() (string, error) {
	dir, err := RuntimeDir()
	if err != nil {
		return "", err
	}
	name := "uv"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(dir, name), nil
}

// VenvPath returns the venv root (~/.blueprint/python/venv).
func VenvPath() (string, error) {
	dir, err := RuntimeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "venv"), nil
}

// VenvPython returns the python executable inside the venv. The
// uv-managed venv puts python at Scripts\python.exe on Windows and
// bin/python on Unix.
func VenvPython() (string, error) {
	venv, err := VenvPath()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(venv, "Scripts", "python.exe"), nil
	}
	return filepath.Join(venv, "bin", "python"), nil
}

// manifestPath is where we record which features are installed.
func manifestPath() (string, error) {
	dir, err := RuntimeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "features.json"), nil
}

// InstalledFeature is one entry in the manifest.
type InstalledFeature struct {
	ID            string `json:"id"`
	InstalledAtMs int64  `json:"installedAtMs"`
}

// Manifest is the on-disk record of what's installed.
type Manifest struct {
	Features []InstalledFeature `json:"features"`
}

var manifestMu sync.Mutex

// LoadManifest reads the manifest file. Missing file = empty manifest.
func LoadManifest() (*Manifest, error) {
	manifestMu.Lock()
	defer manifestMu.Unlock()
	path, err := manifestPath()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Manifest{}, nil
		}
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return &Manifest{}, nil
	}
	return &m, nil
}

// SaveManifest persists. Caller already holds the lock if mutating
// through one of the convenience methods below.
func saveManifestLocked(m *Manifest) error {
	path, err := manifestPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// MarkInstalled records that a feature is now installed. Idempotent.
func MarkInstalled(featureID string) error {
	manifestMu.Lock()
	defer manifestMu.Unlock()
	path, err := manifestPath()
	if err != nil {
		return err
	}
	m := &Manifest{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, m)
	}
	for _, f := range m.Features {
		if f.ID == featureID {
			return nil
		}
	}
	m.Features = append(m.Features, InstalledFeature{
		ID:            featureID,
		InstalledAtMs: time.Now().UnixMilli(),
	})
	return saveManifestLocked(m)
}

// MarkUninstalled removes a feature from the manifest. Idempotent.
func MarkUninstalled(featureID string) error {
	manifestMu.Lock()
	defer manifestMu.Unlock()
	path, err := manifestPath()
	if err != nil {
		return err
	}
	m := &Manifest{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, m)
	}
	kept := m.Features[:0]
	for _, f := range m.Features {
		if f.ID != featureID {
			kept = append(kept, f)
		}
	}
	m.Features = kept
	return saveManifestLocked(m)
}

// IsInstalled reports whether the manifest records the feature.
func IsInstalled(featureID string) bool {
	m, err := LoadManifest()
	if err != nil {
		return false
	}
	for _, f := range m.Features {
		if f.ID == featureID {
			return true
		}
	}
	return false
}

// â”€â”€â”€ Disk space â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// DiskInfo reports free + total bytes on the disk that holds the
// Blueprint data directory. The UI's "do I have room" check.
type DiskInfo struct {
	Path        string `json:"path"`
	TotalBytes  uint64 `json:"totalBytes"`
	FreeBytes   uint64 `json:"freeBytes"`
	UsedPercent uint64 `json:"usedPercent"`
}

// QueryDisk returns disk space info for the volume that holds
// Blueprint's data root.
func QueryDisk() (DiskInfo, error) {
	root, err := paths.Root()
	if err != nil {
		return DiskInfo{}, err
	}
	// Use the parent if root doesn't exist yet â€” gopsutil/disk.Usage
	// can't query a non-existent path on some platforms.
	queryPath := root
	if _, err := os.Stat(root); err != nil {
		queryPath = filepath.Dir(root)
	}
	usage, err := disk.Usage(queryPath)
	if err != nil {
		return DiskInfo{Path: root}, err
	}
	return DiskInfo{
		Path:        root,
		TotalBytes:  usage.Total,
		FreeBytes:   usage.Free,
		UsedPercent: uint64(usage.UsedPercent),
	}, nil
}
