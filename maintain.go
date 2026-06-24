// Maintain IPC surface. Disk inventory of installed model GGUFs,
// targeted deletion, and a check-for-update probe against GitHub for
// the llama.cpp runtime. Compose with the existing Deploy methods to
// implement "swap models" and "restart serve" client-side without
// duplicating the supervision code.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/inspireailab-admin/blueprint/pkg/catalog"
	"github.com/inspireailab-admin/blueprint/pkg/paths"
	"github.com/inspireailab-admin/blueprint/pkg/runtime"
)

// InstalledModel is one entry in the "what's on disk" view. The Maintain
// tab renders these as a list with a delete button per row.
type InstalledModel struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Quant       string `json:"quant"`
	FileName    string `json:"fileName"`
	Path        string `json:"path"`
	BytesSize   int64  `json:"bytesSize"`
}

// InstalledModels scans ~/.blueprint/models for GGUF files declared in
// the catalog. Files we don't recognize are skipped — users who hand-
// dropped GGUFs in there shouldn't see them as deletable from our UI
// (Blueprint doesn't own them).
func (a *App) InstalledModels() ([]InstalledModel, error) {
	root, err := paths.Models()
	if err != nil {
		return nil, err
	}

	models, err := catalog.Load()
	if err != nil {
		return nil, err
	}

	out := make([]InstalledModel, 0)
	for _, m := range models {
		for quant, fileName := range m.QuantFiles() {
			full := filepath.Join(root, m.ID, fileName)
			info, err := os.Stat(full)
			if err != nil {
				continue
			}
			out = append(out, InstalledModel{
				ID:          m.ID,
				DisplayName: m.DisplayName,
				Quant:       quant,
				FileName:    fileName,
				Path:        full,
				BytesSize:   info.Size(),
			})
		}
	}
	return out, nil
}

// DeleteModel removes a previously-pulled GGUF from disk. The caller
// is responsible for stopping a serve that uses this model before
// calling — we don't auto-stop because deleting a model out from under
// a running server is a user mistake we'd rather surface than mask.
func (a *App) DeleteModel(modelID, fileName string) error {
	if modelID == "" || fileName == "" {
		return fmt.Errorf("model id and file name are required")
	}
	if strings.Contains(fileName, "..") || strings.ContainsAny(fileName, "/\\") {
		return fmt.Errorf("invalid file name: %q", fileName)
	}
	// Resolve via the catalog so we can't be tricked into deleting a
	// random path — the catalog's filename has to match.
	model, err := catalog.Get(modelID)
	if err != nil {
		return err
	}
	matched := false
	for _, declared := range model.QuantFiles() {
		if declared == fileName {
			matched = true
			break
		}
	}
	if !matched {
		return fmt.Errorf("file %q is not in the catalog for model %s", fileName, modelID)
	}

	full, err := paths.ModelFile(modelID, fileName)
	if err != nil {
		return err
	}
	if err := os.Remove(full); err != nil {
		return fmt.Errorf("remove %s: %w", full, err)
	}

	// Best-effort: remove the model's directory if it ended up empty.
	root, err := paths.Models()
	if err == nil {
		dir := filepath.Join(root, modelID)
		entries, err := os.ReadDir(dir)
		if err == nil && len(entries) == 0 {
			_ = os.Remove(dir)
		}
	}
	return nil
}

// RuntimeUpdate is what LatestRuntimeVersion returns. The frontend
// compares Installed vs Latest to decide whether to show an
// "Update available" button.
type RuntimeUpdate struct {
	Installed string `json:"installed"`
	Latest    string `json:"latest"`
	HasUpdate bool   `json:"hasUpdate"`
}

// LatestRuntimeVersion hits the GitHub releases API for ggml-org/llama.cpp
// and reports the installed version vs the latest published. Best-effort:
// returns Installed but leaves Latest empty + HasUpdate false if the API
// call fails (the user might be offline; we don't want to break the UI).
func (a *App) LatestRuntimeVersion() RuntimeUpdate {
	out := RuntimeUpdate{Installed: runtime.InstalledVersion()}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", nil)
	if err != nil {
		return out
	}
	req.Header.Set("User-Agent", "blueprint-app")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return out
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return out
	}
	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return out
	}
	out.Latest = rel.TagName
	out.HasUpdate = out.Installed != "" && out.Latest != "" && out.Installed != out.Latest
	return out
}
