// Calibrate IPC surface — exposes the imatrix-calibration + quantize +
// evaluate workflow to the frontend.
//
// Method shape mirrors the deploy.go pattern: cheap query methods
// return their result synchronously, long-running ones return
// immediately and stream progress through Wails events.
//
// Events emitted:
//
//   calibrate:imatrix-progress  {runId, chunks, total}
//   calibrate:imatrix-stage     {runId, stage: "running"|"done"|"error", detail}
//   calibrate:quantize-progress {runId, target, percent}
//   calibrate:quantize-stage    {runId, target, stage}
//   calibrate:run-updated       {runId}        — meta.json changed, UI refreshes
//
// Long-running work happens in goroutines; the IPC method returns nil
// after kicking the work off. The UI listens for events.

package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/inspireailab-admin/blueprint-app/internal/calibration"
	"github.com/inspireailab-admin/blueprint-app/internal/samples"
	"github.com/inspireailab-admin/blueprint/pkg/catalog"
	"github.com/inspireailab-admin/blueprint/pkg/paths"
)

// ─── Public types (Wails-bound) ────────────────────────────────────────────

// CalibrationTools reports whether the binaries we need are present.
// The Calibrate UI uses this to surface a clear "reinstall runtime"
// error rather than mysteriously failing on the first invocation.
type CalibrationTools struct {
	ImatrixBin     string `json:"imatrixBin"`
	ImatrixPresent bool   `json:"imatrixPresent"`
	QuantizeBin    string `json:"quantizeBin"`
	QuantizePresent bool  `json:"quantizePresent"`
}

// ─── Tools probe ───────────────────────────────────────────────────────────

// CalibrationTools reports the on-disk presence of the binaries we
// need to drive the calibration pipeline. Both ship in the llama.cpp
// release alongside llama-server, so if either is missing the runtime
// install needs to be re-run.
func (a *App) CalibrationTools() CalibrationTools {
	out := CalibrationTools{}
	bin, err := paths.Bin()
	if err != nil {
		return out
	}
	out.ImatrixBin = filepath.Join(bin, "llama-imatrix.exe")
	out.QuantizeBin = filepath.Join(bin, "llama-quantize.exe")
	if _, err := os.Stat(out.ImatrixBin); err == nil {
		out.ImatrixPresent = true
	}
	if _, err := os.Stat(out.QuantizeBin); err == nil {
		out.QuantizePresent = true
	}
	return out
}

// ─── Run lifecycle ─────────────────────────────────────────────────────────

// CreateCalibrationRun stamps a fresh run directory and returns the
// run. Caller is expected to upload prompts next.
func (a *App) CreateCalibrationRun(clientLabel string) (*calibration.Run, error) {
	return calibration.CreateRun(clientLabel)
}

// ListCalibrationRuns returns runs sorted newest-first.
func (a *App) ListCalibrationRuns() ([]*calibration.Run, error) {
	return calibration.ListRuns()
}

// GetCalibrationRun returns one run by ID, or nil if it doesn't exist.
func (a *App) GetCalibrationRun(runID string) (*calibration.Run, error) {
	return calibration.ReadRun(runID)
}

// DeleteCalibrationRun removes a run + all artifacts. Irreversible.
func (a *App) DeleteCalibrationRun(runID string) error {
	return calibration.DeleteRun(runID)
}

// ─── Sample datasets ──────────────────────────────────────────────────────

// ListSampleDatasets returns the bundled calibration sample datasets.
// The Calibrate tab's "Load sample" picker renders these as cards.
func (a *App) ListSampleDatasets() []samples.Sample {
	return samples.All()
}

// SeedSampleRun creates a fresh calibration Run pre-populated with the
// chosen sample's prompts + eval set, with "DEMO — " prefixed onto the
// ClientLabel so the user can tell demo runs from real engagements at
// a glance. Recommended base model + base quant are populated so the
// imatrix step can fire without further user input.
func (a *App) SeedSampleRun(sampleID string) (*calibration.Run, error) {
	sample, err := samples.Get(sampleID)
	if err != nil {
		return nil, err
	}

	prompts, err := samples.LoadPrompts(sampleID)
	if err != nil {
		return nil, err
	}
	evalSet, err := samples.LoadEvalSet(sampleID)
	if err != nil {
		return nil, err
	}

	label := fmt.Sprintf("DEMO — %s", sample.Name)
	run, err := calibration.CreateRun(label)
	if err != nil {
		return nil, err
	}

	// Persist prompts (bumps phase to "prompts").
	if _, err := calibration.SavePrompts(run.ID, prompts); err != nil {
		_ = calibration.DeleteRun(run.ID)
		return nil, fmt.Errorf("save prompts: %w", err)
	}
	// Persist eval set (does NOT bump phase past "prompts" — the eval
	// step explicitly checks the JSONL on disk).
	if _, err := calibration.SaveEvalSet(run.ID, evalSet); err != nil {
		_ = calibration.DeleteRun(run.ID)
		return nil, fmt.Errorf("save eval set: %w", err)
	}

	// Stamp the recommended base model + base quant so the user can
	// click "Run calibration" in step 2 without picking the model
	// again. They still need to have pulled it via Deploy.
	if run2, err := calibration.ReadRun(run.ID); err == nil && run2 != nil {
		run2.BaseModelID = sample.BaseModelID
		run2.BaseQuant = sample.BaseQuant
		_ = calibration.WriteRun(run2)
		run = run2
	}

	a.emitRunUpdated(run.ID)
	return run, nil
}

// LoadSampleReadme returns the per-sample README markdown — useful for
// a "details" pane next to the picker.
func (a *App) LoadSampleReadme(sampleID string) (string, error) {
	return samples.LoadReadme(sampleID)
}

// SaveCalibrationPrompts persists the prompt corpus + bumps phase.
func (a *App) SaveCalibrationPrompts(runID, content string) (*calibration.Run, error) {
	run, err := calibration.SavePrompts(runID, content)
	if err != nil {
		return nil, err
	}
	a.emitRunUpdated(runID)
	return run, nil
}

// SaveCalibrationEvalSet persists the eval JSONL.
func (a *App) SaveCalibrationEvalSet(runID, content string) (*calibration.Run, error) {
	run, err := calibration.SaveEvalSet(runID, content)
	if err != nil {
		return nil, err
	}
	a.emitRunUpdated(runID)
	return run, nil
}

// GetCalibrationEvalResults returns the persisted results.json for a
// run, or nil if eval hasn't run yet.
func (a *App) GetCalibrationEvalResults(runID string) (*calibration.EvalResults, error) {
	return calibration.ReadEvalResults(runID)
}

// ─── imatrix calibration ───────────────────────────────────────────────────

// imatrixMu serializes calibration runs across the process — we don't
// want two llama-imatrix invocations competing for VRAM at once.
var imatrixMu sync.Mutex

// RunImatrixCalibration kicks off llama-imatrix for the given run.
// The base GGUF is resolved from the model catalog + the user-chosen
// baseQuant (highest fidelity available is the right default — Q8 or
// FP16). Streams progress over calibrate:imatrix-progress events.
//
// Returns immediately. UI listens for events + polls the run's phase
// to detect completion.
func (a *App) RunImatrixCalibration(runID, baseModelID, baseQuant string) error {
	tools := a.CalibrationTools()
	if !tools.ImatrixPresent {
		return fmt.Errorf("llama-imatrix.exe not found at %s — reinstall runtime", tools.ImatrixBin)
	}

	run, err := calibration.ReadRun(runID)
	if err != nil {
		return err
	}
	if run == nil {
		return fmt.Errorf("run %q does not exist", runID)
	}
	if run.PromptCount == 0 {
		return fmt.Errorf("upload prompts first")
	}

	// Resolve the base GGUF on disk.
	model, err := catalog.Get(baseModelID)
	if err != nil {
		return fmt.Errorf("unknown model %q: %w", baseModelID, err)
	}
	fileName, ok := model.QuantFiles()[baseQuant]
	if !ok {
		return fmt.Errorf("model %s has no %s GGUF in catalog", baseModelID, baseQuant)
	}
	modelPath, err := paths.ModelFile(baseModelID, fileName)
	if err != nil {
		return err
	}
	if _, err := os.Stat(modelPath); err != nil {
		return fmt.Errorf("base GGUF not on disk: %s — pull %s %s first via Deploy", modelPath, baseModelID, baseQuant)
	}

	promptsPath, err := calibration.PromptsPath(runID)
	if err != nil {
		return err
	}
	imatrixOut, err := calibration.ImatrixPath(runID)
	if err != nil {
		return err
	}

	// Update run state before kicking off — UI sees "imatrix running".
	run.BaseModelID = baseModelID
	run.BaseQuant = baseQuant
	run.Phase = calibration.PhaseImatrix
	run.LastError = ""
	run.ImatrixChunks = 0
	run.ImatrixTotal = 0
	if err := calibration.WriteRun(run); err != nil {
		return err
	}
	a.emitRunUpdated(runID)

	go a.runImatrixWorker(runID, tools.ImatrixBin, modelPath, promptsPath, imatrixOut)
	return nil
}

func (a *App) runImatrixWorker(runID, bin, modelPath, promptsPath, imatrixOut string) {
	imatrixMu.Lock()
	defer imatrixMu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cmd := exec.CommandContext(ctx, bin,
		"--model", modelPath,
		"--file", promptsPath,
		"--output", imatrixOut,
		"--chunks", "100",
	)
	hideConsole(cmd)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		a.failRun(runID, fmt.Errorf("stderr pipe: %w", err))
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		a.failRun(runID, fmt.Errorf("stdout pipe: %w", err))
		return
	}

	wailsruntime.EventsEmit(a.ctx, "calibrate:imatrix-stage",
		map[string]string{"runId": runID, "stage": "running"})

	if err := cmd.Start(); err != nil {
		a.failRun(runID, fmt.Errorf("start llama-imatrix: %w", err))
		return
	}

	// llama-imatrix's progress lines go to stderr; merge both streams
	// and scan for chunk counters.
	go a.scanImatrixLines(runID, stderr)
	go a.scanImatrixLines(runID, stdout)

	if err := cmd.Wait(); err != nil {
		a.failRun(runID, fmt.Errorf("llama-imatrix exited: %w", err))
		return
	}

	// Success — bump phase, emit done.
	run, err := calibration.ReadRun(runID)
	if err == nil && run != nil {
		run.Phase = calibration.PhaseImatrixOK
		_ = calibration.WriteRun(run)
	}
	wailsruntime.EventsEmit(a.ctx, "calibrate:imatrix-stage",
		map[string]string{"runId": runID, "stage": "done"})
	a.emitRunUpdated(runID)
}

// scanImatrixLines watches llama-imatrix output for progress markers.
// Format varies between llama.cpp versions; we match defensively on
// both "[42/100]" bracket and "42 of 100 chunks" sentence forms.
func (a *App) scanImatrixLines(runID string, r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if chunks, total, ok := parseImatrixProgress(line); ok {
			wailsruntime.EventsEmit(a.ctx, "calibrate:imatrix-progress",
				map[string]int{"chunks": chunks, "total": total})
			// Cheap update of meta.json too so a UI re-mount picks it up.
			run, err := calibration.ReadRun(runID)
			if err == nil && run != nil {
				run.ImatrixChunks = chunks
				run.ImatrixTotal = total
				_ = calibration.WriteRun(run)
			}
		}
	}
}

// parseImatrixProgress finds a "i/n" chunk counter in a log line.
// Two common shapes:
//
//	compute_imatrix: computing over 42 of 100 chunks
//	[42/100] perplexity = ...
func parseImatrixProgress(line string) (chunks, total int, ok bool) {
	// Bracket form.
	if l := strings.Index(line, "["); l >= 0 {
		if r := strings.Index(line[l:], "]"); r > 0 {
			inner := line[l+1 : l+r]
			if i, n, parsed := parseFraction(inner); parsed {
				return i, n, true
			}
		}
	}
	// Sentence form.
	const marker = " of "
	if l := strings.Index(line, marker); l > 0 {
		head := strings.TrimSpace(line[:l])
		// Walk backward to find the number.
		words := strings.Fields(head)
		if len(words) > 0 {
			if i, err := strconv.Atoi(words[len(words)-1]); err == nil {
				tail := strings.TrimSpace(line[l+len(marker):])
				tailWords := strings.Fields(tail)
				if len(tailWords) > 0 {
					if n, err := strconv.Atoi(tailWords[0]); err == nil {
						return i, n, true
					}
				}
			}
		}
	}
	return 0, 0, false
}

func parseFraction(s string) (a, b int, ok bool) {
	slash := strings.Index(s, "/")
	if slash <= 0 {
		return 0, 0, false
	}
	a, err1 := strconv.Atoi(strings.TrimSpace(s[:slash]))
	b, err2 := strconv.Atoi(strings.TrimSpace(s[slash+1:]))
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return a, b, true
}

// failRun is the common error path — records the error in meta.json,
// flips phase to PhaseError, emits a stage event.
func (a *App) failRun(runID string, err error) {
	run, ferr := calibration.ReadRun(runID)
	if ferr == nil && run != nil {
		run.Phase = calibration.PhaseError
		run.LastError = err.Error()
		_ = calibration.WriteRun(run)
	}
	wailsruntime.EventsEmit(a.ctx, "calibrate:imatrix-stage",
		map[string]string{"runId": runID, "stage": "error", "detail": err.Error()})
	a.emitRunUpdated(runID)
}

func (a *App) emitRunUpdated(runID string) {
	wailsruntime.EventsEmit(a.ctx, "calibrate:run-updated", map[string]string{"runId": runID})
}

// ─── Quantize ──────────────────────────────────────────────────────────────

// RunCalibratedQuantization spawns llama-quantize once per target,
// passing --imatrix so the calibration matrix steers the per-tensor
// rounding. Outputs go to <runDir>/quants/<target>.gguf.
func (a *App) RunCalibratedQuantization(runID string, targets []string) error {
	tools := a.CalibrationTools()
	if !tools.QuantizePresent {
		return fmt.Errorf("llama-quantize.exe not found at %s — reinstall runtime", tools.QuantizeBin)
	}
	if len(targets) == 0 {
		return fmt.Errorf("pick at least one target quant (e.g. Q4_K_M)")
	}

	run, err := calibration.ReadRun(runID)
	if err != nil {
		return err
	}
	if run == nil {
		return fmt.Errorf("run %q does not exist", runID)
	}
	if run.Phase != calibration.PhaseImatrixOK && run.Phase != calibration.PhaseQuantizeOK {
		return fmt.Errorf("calibration not finished — current phase %q", run.Phase)
	}

	model, err := catalog.Get(run.BaseModelID)
	if err != nil {
		return err
	}
	srcName, ok := model.QuantFiles()[run.BaseQuant]
	if !ok {
		return fmt.Errorf("base GGUF mapping missing for %s %s", run.BaseModelID, run.BaseQuant)
	}
	srcPath, err := paths.ModelFile(run.BaseModelID, srcName)
	if err != nil {
		return err
	}
	imxPath, err := calibration.ImatrixPath(runID)
	if err != nil {
		return err
	}
	outDir, err := calibration.QuantsDir(runID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}

	run.TargetQuants = targets
	run.Phase = calibration.PhaseQuantize
	run.LastError = ""
	if err := calibration.WriteRun(run); err != nil {
		return err
	}
	a.emitRunUpdated(runID)

	go a.runQuantizeWorker(runID, tools.QuantizeBin, srcPath, imxPath, outDir, targets)
	return nil
}

func (a *App) runQuantizeWorker(runID, bin, srcPath, imxPath, outDir string, targets []string) {
	for _, target := range targets {
		outPath := filepath.Join(outDir, target+".gguf")
		wailsruntime.EventsEmit(a.ctx, "calibrate:quantize-stage",
			map[string]string{"runId": runID, "target": target, "stage": "running"})

		cmd := exec.Command(bin,
			"--imatrix", imxPath,
			srcPath,
			outPath,
			target,
		)
		hideConsole(cmd)
		out, err := cmd.CombinedOutput()
		if err != nil {
			snippet := string(out)
			if len(snippet) > 500 {
				snippet = snippet[len(snippet)-500:]
			}
			a.failRun(runID, fmt.Errorf("quantize %s failed: %w\n%s", target, err, snippet))
			return
		}
		wailsruntime.EventsEmit(a.ctx, "calibrate:quantize-stage",
			map[string]string{"runId": runID, "target": target, "stage": "done"})
	}

	run, err := calibration.ReadRun(runID)
	if err == nil && run != nil {
		run.Phase = calibration.PhaseQuantizeOK
		_ = calibration.WriteRun(run)
	}
	a.emitRunUpdated(runID)
}

