// Calibration eval runner — step 5 of the workflow. For each candidate
// GGUF (calibrated outputs from this run + any same-target stock
// pre-quants on disk for an apples-to-apples "ours vs theirs" story),
// spin a temporary llama-server bound to an ephemeral port, replay the
// eval set, measure TTFT + throughput + quality, then kill the
// server and move on.
//
// Persists results.json + flips the run's phase to eval-ok on success.

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/inspireailab-admin/blueprint-app/internal/calibration"
	"github.com/inspireailab-admin/blueprint/pkg/catalog"
	"github.com/inspireailab-admin/blueprint/pkg/paths"
	"github.com/inspireailab-admin/blueprint/pkg/runtime"
)

// ─── Public types ──────────────────────────────────────────────────────────

// EvalCandidate is one GGUF available for evaluation in a given run.
// The UI presents all candidates as checkboxes; user picks which to
// score.
type EvalCandidate struct {
	Label       string `json:"label"`       // human label
	Source      string `json:"source"`      // "calibrated" | "stock"
	QuantTarget string `json:"quantTarget"` // e.g. "Q4_K_M"
	GGUFPath    string `json:"ggufPath"`
	FileSize    int64  `json:"fileSize"`
}

// EvalRunInput is what the UI POSTs to RunCalibrationEval.
type EvalRunInput struct {
	RunID           string   `json:"runId"`
	Candidates      []string `json:"candidates"`      // GGUF paths the user ticked
	DefaultScoring  string   `json:"defaultScoring"`  // "rouge-l" or "exact"
	MaxTokens       int      `json:"maxTokens"`       // per-eval-prompt cap
	CtxSize         int      `json:"ctxSize"`         // server ctx
	NGpuLayers      int      `json:"nGpuLayers"`      // GPU offload
}

// ─── IPC: candidates listing ───────────────────────────────────────────────

// ListEvalCandidates surveys what's on disk for a given run: the
// run's own calibrated GGUFs plus any same-model stock pre-quants the
// user has already pulled via Deploy. The mapping from llama.cpp
// target names (Q4_K_M) to catalog keys (q4) is best-effort — when
// in doubt we surface the file anyway so the user can decide.
func (a *App) ListEvalCandidates(runID string) ([]EvalCandidate, error) {
	run, err := calibration.ReadRun(runID)
	if err != nil || run == nil {
		return nil, fmt.Errorf("run %q not found", runID)
	}

	out := make([]EvalCandidate, 0, 8)

	// Calibrated outputs from this run.
	quantsDir, err := calibration.QuantsDir(runID)
	if err == nil {
		entries, _ := os.ReadDir(quantsDir)
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".gguf") {
				continue
			}
			full := filepath.Join(quantsDir, e.Name())
			info, _ := os.Stat(full)
			target := strings.TrimSuffix(e.Name(), ".gguf")
			out = append(out, EvalCandidate{
				Label:       target + " (calibrated)",
				Source:      "calibrated",
				QuantTarget: target,
				GGUFPath:    full,
				FileSize:    sizeOrZero(info),
			})
		}
	}

	// Stock pre-quants from the catalog model directory — show every
	// .gguf there so user has the full apples-to-apples picture.
	if run.BaseModelID != "" {
		modelsRoot, err := paths.Models()
		if err == nil {
			dir := filepath.Join(modelsRoot, run.BaseModelID)
			if entries, err := os.ReadDir(dir); err == nil {
				for _, e := range entries {
					if e.IsDir() || !strings.HasSuffix(e.Name(), ".gguf") {
						continue
					}
					full := filepath.Join(dir, e.Name())
					info, _ := os.Stat(full)
					target := guessQuantFromFilename(e.Name())
					out = append(out, EvalCandidate{
						Label:       fmt.Sprintf("%s (stock)", target),
						Source:      "stock",
						QuantTarget: target,
						GGUFPath:    full,
						FileSize:    sizeOrZero(info),
					})
				}
			}
		}
	}

	return out, nil
}

func sizeOrZero(info os.FileInfo) int64 {
	if info == nil {
		return 0
	}
	return info.Size()
}

// guessQuantFromFilename pulls the quant token out of a GGUF filename
// — useful for the stock files which embed their quant in the name
// (e.g. "Qwen2.5-7B-Instruct-Q4_K_M.gguf" → "Q4_K_M").
func guessQuantFromFilename(name string) string {
	stem := strings.TrimSuffix(name, ".gguf")
	tokens := strings.Split(stem, "-")
	for i := len(tokens) - 1; i >= 0; i-- {
		t := tokens[i]
		up := strings.ToUpper(t)
		if strings.HasPrefix(up, "Q") || strings.HasPrefix(up, "IQ") || up == "F16" || up == "FP16" {
			// Q4_K_M is typically two tokens "Q4_K_M" or "Q4_K_M" depending on
			// split; join the last 1-3 tokens that look quant-y.
			start := i
			for start > 0 && looksQuantToken(tokens[start-1]) {
				start--
			}
			return strings.Join(tokens[start:], "_")
		}
	}
	return stem
}

func looksQuantToken(t string) bool {
	up := strings.ToUpper(t)
	if len(up) <= 4 && (strings.HasPrefix(up, "Q") || strings.HasPrefix(up, "IQ") || up == "M" || up == "S" || up == "L" || up == "XS" || up == "XXS") {
		return true
	}
	return false
}

// ─── IPC: run the eval ─────────────────────────────────────────────────────

// evalMu serializes eval runs across the process — only one
// llama-server lifecycle at a time so we never collide on the
// ephemeral port or starve the active service of VRAM.
var evalMu sync.Mutex

// RunCalibrationEval fires the worker that loops over candidates,
// running llama-server per candidate. Returns immediately; the UI
// watches calibrate:eval-progress events + meta phase.
func (a *App) RunCalibrationEval(in EvalRunInput) error {
	run, err := calibration.ReadRun(in.RunID)
	if err != nil || run == nil {
		return fmt.Errorf("run %q not found", in.RunID)
	}
	if run.Phase != calibration.PhaseQuantizeOK && run.Phase != calibration.PhaseEvalOK {
		return fmt.Errorf("quantization not finished — current phase %q", run.Phase)
	}
	if run.EvalSetCount == 0 {
		return fmt.Errorf("upload an eval set first")
	}
	if len(in.Candidates) == 0 {
		return fmt.Errorf("pick at least one candidate to evaluate")
	}

	bin, err := runtime.Find()
	if err != nil {
		return fmt.Errorf("llama-server not installed: %w", err)
	}

	entries, err := calibration.ReadEvalSet(in.RunID)
	if err != nil {
		return fmt.Errorf("read eval set: %w", err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("eval set has no valid prompts")
	}

	defaultScoring := calibration.Scoring(in.DefaultScoring)
	if defaultScoring != calibration.ScoringExact && defaultScoring != calibration.ScoringRougeL {
		defaultScoring = calibration.ScoringRougeL
	}
	ctxSize := in.CtxSize
	if ctxSize <= 0 {
		ctxSize = 4096
	}
	nGpu := in.NGpuLayers
	if nGpu < 0 {
		nGpu = 999
	}
	maxTokens := in.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 512
	}

	run.Phase = calibration.PhaseEval
	run.LastError = ""
	if err := calibration.WriteRun(run); err != nil {
		return err
	}
	a.emitRunUpdated(in.RunID)

	go a.runEvalWorker(in.RunID, bin, in.Candidates, entries, defaultScoring, ctxSize, nGpu, maxTokens)
	return nil
}

func (a *App) runEvalWorker(
	runID, bin string,
	candidates []string,
	entries []calibration.EvalEntry,
	defaultScoring calibration.Scoring,
	ctxSize, nGpu, maxTokens int,
) {
	evalMu.Lock()
	defer evalMu.Unlock()

	results := &calibration.EvalResults{
		StartedAtMs:    time.Now().UnixMilli(),
		DefaultScoring: defaultScoring,
		EvalSetCount:   len(entries),
		Candidates:     make([]calibration.CandidateResult, 0, len(candidates)),
	}

	for _, ggufPath := range candidates {
		a.emitEvalProgress(runID, map[string]any{
			"candidate": ggufPath,
			"stage":     "starting",
		})

		cand, err := a.evalOneCandidate(runID, bin, ggufPath, entries, defaultScoring, ctxSize, nGpu, maxTokens)
		if err != nil {
			a.failRun(runID, fmt.Errorf("eval %s: %w", filepath.Base(ggufPath), err))
			return
		}
		results.Candidates = append(results.Candidates, *cand)

		// Persist progressively so a crash mid-way still leaves
		// something the user can inspect.
		results.FinishedAtMs = time.Now().UnixMilli()
		_ = calibration.WriteEvalResults(runID, results)

		a.emitEvalProgress(runID, map[string]any{
			"candidate": ggufPath,
			"stage":     "done",
			"meanScore": cand.MeanScore,
		})
	}

	run, err := calibration.ReadRun(runID)
	if err == nil && run != nil {
		run.Phase = calibration.PhaseEvalOK
		_ = calibration.WriteRun(run)
	}
	a.emitRunUpdated(runID)
	a.emitEvalProgress(runID, map[string]any{"stage": "all-done"})
}

// evalOneCandidate is the meat of the harness — boot a llama-server
// bound to an ephemeral port, replay every eval entry against it,
// score each response, aggregate, kill the server.
func (a *App) evalOneCandidate(
	runID, bin, ggufPath string,
	entries []calibration.EvalEntry,
	defaultScoring calibration.Scoring,
	ctxSize, nGpu, maxTokens int,
) (*calibration.CandidateResult, error) {
	info, err := os.Stat(ggufPath)
	if err != nil {
		return nil, fmt.Errorf("gguf not found: %w", err)
	}

	port, err := pickFreePort()
	if err != nil {
		return nil, err
	}
	apiKey, err := newApiKey()
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cmd := exec.CommandContext(ctx, bin,
		"--model", ggufPath,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(port),
		"--api-key", apiKey,
		"--ctx-size", strconv.Itoa(ctxSize),
		"--n-gpu-layers", strconv.Itoa(nGpu),
	)
	hideConsole(cmd)
	// Drop stdout/stderr into the calibration run's eval-log file for
	// debugging when something goes sideways.
	logPath, _ := calibration.RunDir(runID)
	if logPath != "" {
		logFile, err := os.OpenFile(filepath.Join(logPath, "eval-server.log"),
			os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			defer logFile.Close()
			cmd.Stdout = logFile
			cmd.Stderr = logFile
		}
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start llama-server: %w", err)
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		// Drain.
		_ = cmd.Wait()
	}()

	// Wait for /health.
	if !waitForHealthy(ctx, port, apiKey, 120*time.Second) {
		return nil, fmt.Errorf("llama-server didn't become healthy in 120 s")
	}

	cand := &calibration.CandidateResult{
		Label:         filepath.Base(ggufPath),
		Source:        sourceFromPath(ggufPath, runID),
		QuantTarget:   strings.TrimSuffix(filepath.Base(ggufPath), ".gguf"),
		GGUFPath:      ggufPath,
		FileSizeBytes: info.Size(),
		Rows:          make([]calibration.PromptResult, 0, len(entries)),
	}

	endpoint := fmt.Sprintf("http://127.0.0.1:%d/v1/chat/completions", port)

	var (
		scoreSum   float64
		scoreN     int
		ttftSamples []int64
		tpsSamples  []float64
	)

	for idx, entry := range entries {
		scoring := defaultScoring
		if entry.Scoring != "" {
			scoring = entry.Scoring
		}

		predicted, ttftMs, genTokens, genSec, err := streamCompletion(
			ctx, endpoint, apiKey, entry.Prompt, maxTokens,
		)
		row := calibration.PromptResult{
			Prompt:    entry.Prompt,
			Expected:  entry.Expected,
			Predicted: predicted,
			TTFTms:    ttftMs,
			GenTokens: genTokens,
			GenSeconds: genSec,
		}
		if genSec > 0 {
			row.TokensPerSec = float64(genTokens) / genSec
		}
		if err != nil {
			row.Error = err.Error()
			cand.NumFailed++
		} else {
			row.Score = calibration.ScoreFor(scoring, predicted, entry.Expected)
			scoreSum += row.Score
			scoreN++
			cand.NumScored++
			if ttftMs > 0 {
				ttftSamples = append(ttftSamples, ttftMs)
			}
			if row.TokensPerSec > 0 {
				tpsSamples = append(tpsSamples, row.TokensPerSec)
			}
		}
		cand.Rows = append(cand.Rows, row)

		a.emitEvalProgress(runID, map[string]any{
			"candidate": ggufPath,
			"stage":     "row",
			"row":       idx + 1,
			"of":        len(entries),
			"score":     row.Score,
		})
	}

	if scoreN > 0 {
		cand.MeanScore = scoreSum / float64(scoreN)
	}
	if len(ttftSamples) > 0 {
		sorted := calibration.SortedCopy(ttftSamples)
		cand.MedianTTFTms = calibration.Percentile(sorted, 50)
		cand.P95TTFTms = calibration.Percentile(sorted, 95)
	}
	if len(tpsSamples) > 0 {
		var sum float64
		for _, v := range tpsSamples {
			sum += v
		}
		cand.MeanTokPerSec = sum / float64(len(tpsSamples))
	}

	return cand, nil
}

func sourceFromPath(ggufPath, runID string) string {
	quantsDir, _ := calibration.QuantsDir(runID)
	if strings.HasPrefix(ggufPath, quantsDir) {
		return "calibrated"
	}
	return "stock"
}

// ─── HTTP plumbing ─────────────────────────────────────────────────────────

func waitForHealthy(ctx context.Context, port int, apiKey string, timeout time.Duration) bool {
	url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return false
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err == nil {
			req.Header.Set("Authorization", "Bearer "+apiKey)
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

type chatStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
}

// streamCompletion POSTs a chat completion with streaming and measures
// TTFT (time-to-first-token) + generation seconds + token count
// (approximated by the number of streamed delta chunks, which is
// close enough to true token count for relative comparisons across
// candidates on the same hardware).
func streamCompletion(
	ctx context.Context, endpoint, apiKey, prompt string, maxTokens int,
) (predicted string, ttftMs int64, genTokens int, genSec float64, err error) {
	body, _ := json.Marshal(map[string]any{
		"model":      "local",
		"stream":     true,
		"max_tokens": maxTokens,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", 0, 0, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	t0 := time.Now()
	var tFirst time.Time
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return "", 0, 0, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return "", 0, 0, 0, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	reader := bufio.NewReader(resp.Body)
	var acc strings.Builder
	chunks := 0
	for {
		line, rerr := reader.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "data:") {
				payload := strings.TrimSpace(line[5:])
				if payload == "[DONE]" {
					break
				}
				var c chatStreamChunk
				if json.Unmarshal([]byte(payload), &c) == nil && len(c.Choices) > 0 {
					content := c.Choices[0].Delta.Content
					if content != "" {
						if tFirst.IsZero() {
							tFirst = time.Now()
						}
						acc.WriteString(content)
						chunks++
					}
				}
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			break
		}
	}

	tEnd := time.Now()
	if tFirst.IsZero() {
		// Nothing streamed back — count TTFT as the full round trip.
		tFirst = tEnd
	}
	ttftMs = tFirst.Sub(t0).Milliseconds()
	genSec = tEnd.Sub(tFirst).Seconds()
	return acc.String(), ttftMs, chunks, genSec, nil
}

// ─── Misc helpers ──────────────────────────────────────────────────────────

// pickFreePort walks 17150..17300 looking for a port we can bind.
// Stepping away from 8080 (main service) and the system ephemeral
// range so multiple parallel runs can coexist.
func pickFreePort() (int, error) {
	for p := 17150; p <= 17300; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			ln.Close()
			return p, nil
		}
	}
	return 0, fmt.Errorf("no free port available in 17150..17300")
}

func newApiKey() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (a *App) emitEvalProgress(runID string, payload map[string]any) {
	payload["runId"] = runID
	wailsruntime.EventsEmit(a.ctx, "calibrate:eval-progress", payload)
}

// Catalog import is kept in case future steps want to resolve model
// names from quants.
var _ = catalog.Get
