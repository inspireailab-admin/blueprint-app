// Compress IPC — LLMLingua prompt compression via the Python sidecar.
//
// Lifecycle: lazy. First CompressPrompt call spawns the sidecar and
// waits for /health. Subsequent calls reuse the running process.
// Sidecar dies with the app (no explicit Stop — Python process gets
// cleaned up via the kill on context cancel).

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/pyruntime"
	"github.com/inspireailab-admin/blueprint-app/internal/sidecar"
)

// ─── Lifecycle ────────────────────────────────────────────────────────────

var (
	compressMu      sync.Mutex
	compressSidecar *sidecar.Sidecar
)

func ensureCompressSidecar() (*sidecar.Sidecar, error) {
	compressMu.Lock()
	defer compressMu.Unlock()

	if compressSidecar != nil {
		// Health check: if the process died, restart it.
		if err := compressSidecar.WaitHealthy(1 * time.Second); err == nil {
			return compressSidecar, nil
		}
		compressSidecar.Stop()
		compressSidecar = nil
	}

	if !pyruntime.IsInstalled(pyruntime.FeatureLLMLingua) {
		return nil, fmt.Errorf("LLMLingua not installed — install it from the Dashboard's Python runtime card")
	}

	s, err := sidecar.Spawn("compress.py", nil)
	if err != nil {
		return nil, err
	}
	// LLMLingua's first /compress call loads the model — that's slow
	// (~20-40 s on CPU). /health responds immediately so we wait just
	// for that, then surface the model-load delay on the first request.
	if err := s.WaitHealthy(30 * time.Second); err != nil {
		s.Stop()
		return nil, err
	}
	compressSidecar = s
	return s, nil
}

// CompressStatus reports whether the sidecar is reachable. The
// Dashboard's chat panel renders the Compress button based on this.
type CompressStatus struct {
	FeatureInstalled bool   `json:"featureInstalled"`
	SidecarRunning   bool   `json:"sidecarRunning"`
	SidecarPort      int    `json:"sidecarPort,omitempty"`
	Model            string `json:"model,omitempty"`
	LastError        string `json:"lastError,omitempty"`
}

// CompressStatus is a cheap probe the UI polls.
func (a *App) CompressStatus() CompressStatus {
	out := CompressStatus{
		FeatureInstalled: pyruntime.IsInstalled(pyruntime.FeatureLLMLingua),
	}
	compressMu.Lock()
	s := compressSidecar
	compressMu.Unlock()
	if s == nil {
		return out
	}
	out.SidecarRunning = true
	out.SidecarPort = s.Port
	// Best-effort info fetch — non-blocking; failures leave Model empty.
	resp, err := http.Get(fmt.Sprintf("%s/info", s.BaseURL()))
	if err == nil {
		defer resp.Body.Close()
		var info struct {
			Model string `json:"model"`
		}
		if json.NewDecoder(resp.Body).Decode(&info) == nil {
			out.Model = info.Model
		}
	}
	return out
}

// ─── Compress request ─────────────────────────────────────────────────────

// CompressRequest is the IPC input the frontend sends.
type CompressRequest struct {
	Text             string  `json:"text"`
	TargetRatio      float64 `json:"targetRatio"`
	PreserveQuestion bool    `json:"preserveQuestion"`
}

// CompressResult is what the sidecar returns. Numbers let the UI show
// "your prompt shrank from 1024 to 412 tokens (2.5x)."
type CompressResult struct {
	Compressed       string  `json:"compressed"`
	OriginalTokens   int     `json:"originalTokens"`
	CompressedTokens int     `json:"compressedTokens"`
	Ratio            float64 `json:"ratio"`
	Model            string  `json:"model"`
}

// CompressPrompt sends a prompt to the sidecar and returns the
// compressed text + token counts. Spawns the sidecar lazily.
func (a *App) CompressPrompt(req CompressRequest) (*CompressResult, error) {
	if req.TargetRatio <= 0 {
		req.TargetRatio = 0.5
	}
	if req.TargetRatio > 0.95 {
		req.TargetRatio = 0.95
	}
	s, err := ensureCompressSidecar()
	if err != nil {
		return nil, err
	}

	body, err := json.Marshal(map[string]any{
		"text":              req.Text,
		"target_ratio":      req.TargetRatio,
		"preserve_question": req.PreserveQuestion,
	})
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s/compress", s.BaseURL())
	httpReq, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	// First call loads the model — generous timeout.
	client := &http.Client{Timeout: 180 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("compress: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var probe map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&probe)
		return nil, fmt.Errorf("compress: HTTP %d: %v", resp.StatusCode, probe)
	}
	var result CompressResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode compress response: %w", err)
	}
	return &result, nil
}

// StopCompressSidecar kills the running sidecar (used when the user
// uninstalls LLMLingua or wants to free the memory).
func (a *App) StopCompressSidecar() {
	compressMu.Lock()
	defer compressMu.Unlock()
	if compressSidecar != nil {
		compressSidecar.Stop()
		compressSidecar = nil
	}
}
