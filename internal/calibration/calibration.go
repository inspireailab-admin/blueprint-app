// Package calibration manages on-disk state for custom-quantization
// runs. Each run is a self-contained directory holding:
//
//	~/.blueprint/calibration/<runID>/
//	â”œâ”€â”€ meta.json           â€” run metadata (timestamps, target model, status)
//	â”œâ”€â”€ prompts.txt         â€” user-supplied calibration corpus (one prompt per line)
//	â”œâ”€â”€ eval.jsonl          â€” optional evaluation set: {prompt, expected[, judge]}
//	â”œâ”€â”€ imatrix.dat         â€” output of llama-imatrix
//	â”œâ”€â”€ quants/             â€” custom-calibrated GGUFs (one per target quant)
//	â”œâ”€â”€ eval-results.json   â€” per-candidate quality + perf measurements
//	â””â”€â”€ report.md           â€” client-ready summary
//
// The point of the structure is that each run is shareable, archivable,
// and reproducible â€” a Blueprint consulting engagement produces one
// directory as its deliverable.
package calibration

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"
)

// Phase tracks where a run is in the calibrate-quantize-evaluate flow.
type Phase string

const (
	PhaseDraft      Phase = "draft"       // created, awaiting prompts
	PhasePrompts    Phase = "prompts"     // prompts uploaded, ready to calibrate
	PhaseImatrix    Phase = "imatrix"     // llama-imatrix running
	PhaseImatrixOK  Phase = "imatrix-ok"  // .imatrix produced
	PhaseQuantize   Phase = "quantize"    // llama-quantize running
	PhaseQuantizeOK Phase = "quantize-ok" // calibrated GGUFs produced
	PhaseEval       Phase = "eval"        // running eval set against candidates
	PhaseEvalOK     Phase = "eval-ok"     // results.json ready
	PhaseError      Phase = "error"
)

// Run is the persisted metadata for a single calibration engagement.
//
// Timestamps are unix milliseconds rather than time.Time because Wails
// can't marshal time.Time across the JS bridge â€” Number is the common
// language for date math on both sides.
type Run struct {
	ID            string   `json:"id"`
	CreatedAtMs   int64    `json:"createdAt"`
	UpdatedAtMs   int64    `json:"updatedAt"`
	ClientLabel   string   `json:"clientLabel"`
	BaseModelID   string   `json:"baseModelId"`
	BaseQuant     string   `json:"baseQuant"`
	Phase         Phase    `json:"phase"`
	PromptCount   int      `json:"promptCount"`
	EvalSetCount  int      `json:"evalSetCount"`
	TargetQuants  []string `json:"targetQuants"`
	LastError     string   `json:"lastError"`
	ImatrixChunks int      `json:"imatrixChunks"`
	ImatrixTotal  int      `json:"imatrixTotal"`
}

// CalibrationRoot is the umbrella directory under ~/.blueprint that
// holds every calibration run. Lazily created on first use.
func CalibrationRoot() (string, error) {
	root, err := paths.Root()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, "calibration")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// RunDir resolves the directory for a specific run.
func RunDir(runID string) (string, error) {
	if !validRunID(runID) {
		return "", fmt.Errorf("invalid run id %q", runID)
	}
	root, err := CalibrationRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, runID), nil
}

// File paths inside a run directory â€” central so callers don't sprinkle
// filename literals everywhere.

func metaPath(runID string) (string, error)         { return inRun(runID, "meta.json") }
func promptsPath(runID string) (string, error)      { return inRun(runID, "prompts.txt") }
func evalSetPath(runID string) (string, error)      { return inRun(runID, "eval.jsonl") }
func imatrixPath(runID string) (string, error)      { return inRun(runID, "imatrix.dat") }
func evalResultsPath(runID string) (string, error)  { return inRun(runID, "eval-results.json") }
func reportPath(runID string) (string, error)       { return inRun(runID, "report.md") }
func quantsDir(runID string) (string, error)        { return inRun(runID, "quants") }

func PromptsPath(runID string) (string, error)     { return promptsPath(runID) }
func ImatrixPath(runID string) (string, error)     { return imatrixPath(runID) }
func EvalSetPath(runID string) (string, error)     { return evalSetPath(runID) }
func EvalResultsPath(runID string) (string, error) { return evalResultsPath(runID) }
func ReportPath(runID string) (string, error)      { return reportPath(runID) }
func QuantsDir(runID string) (string, error)       { return quantsDir(runID) }

func inRun(runID, name string) (string, error) {
	dir, err := RunDir(runID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, name), nil
}

// CreateRun stamps a new directory + meta.json and returns the run.
func CreateRun(clientLabel string) (*Run, error) {
	id := newRunID()
	dir, err := RunDir(id)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	run := &Run{
		ID:          id,
		CreatedAtMs: now,
		UpdatedAtMs: now,
		ClientLabel: clientLabel,
		Phase:       PhaseDraft,
	}
	if err := WriteRun(run); err != nil {
		return nil, err
	}
	return run, nil
}

// ReadRun loads meta.json. Returns nil, nil when the run doesn't exist
// (sentinel for "missing", separate from an actual read error).
func ReadRun(runID string) (*Run, error) {
	path, err := metaPath(runID)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var r Run
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// WriteRun persists the run's meta.json, stamping UpdatedAtMs.
func WriteRun(r *Run) error {
	r.UpdatedAtMs = time.Now().UnixMilli()
	path, err := metaPath(r.ID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// ListRuns returns runs sorted newest-first by CreatedAt.
func ListRuns() ([]*Run, error) {
	root, err := CalibrationRoot()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	runs := make([]*Run, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() || !validRunID(e.Name()) {
			continue
		}
		r, err := ReadRun(e.Name())
		if err != nil || r == nil {
			continue
		}
		runs = append(runs, r)
	}
	sort.Slice(runs, func(i, j int) bool {
		return runs[i].CreatedAtMs > runs[j].CreatedAtMs
	})
	return runs, nil
}

// DeleteRun removes a run directory and everything in it. Used for
// "throw this away, start over" â€” there's no undo.
func DeleteRun(runID string) error {
	dir, err := RunDir(runID)
	if err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

// SavePrompts writes prompts.txt and updates the run's PromptCount +
// Phase. The supervisor that runs llama-imatrix reads from the same
// file, so this is the single source of truth.
func SavePrompts(runID string, content string) (*Run, error) {
	run, err := ReadRun(runID)
	if err != nil {
		return nil, err
	}
	if run == nil {
		return nil, fmt.Errorf("run %q does not exist", runID)
	}
	path, err := promptsPath(runID)
	if err != nil {
		return nil, err
	}
	// Normalize line endings to \n; reject empty / whitespace-only lines.
	normalized, count := normalizePrompts(content)
	if count == 0 {
		return nil, fmt.Errorf("no non-empty prompt lines found")
	}
	if err := os.WriteFile(path, []byte(normalized), 0o644); err != nil {
		return nil, err
	}
	run.PromptCount = count
	if run.Phase == PhaseDraft {
		run.Phase = PhasePrompts
	}
	if err := WriteRun(run); err != nil {
		return nil, err
	}
	return run, nil
}

// SaveEvalSet writes eval.jsonl and updates EvalSetCount. Each line
// is expected to parse as JSON with at least a "prompt" field;
// validation is best-effort here (count valid lines) and stricter at
// evaluation time.
func SaveEvalSet(runID string, content string) (*Run, error) {
	run, err := ReadRun(runID)
	if err != nil {
		return nil, err
	}
	if run == nil {
		return nil, fmt.Errorf("run %q does not exist", runID)
	}
	path, err := evalSetPath(runID)
	if err != nil {
		return nil, err
	}
	count := 0
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var probe map[string]any
		if err := json.Unmarshal([]byte(line), &probe); err == nil {
			if _, hasPrompt := probe["prompt"]; hasPrompt {
				count++
			}
		}
	}
	if count == 0 {
		return nil, fmt.Errorf("no valid {\"prompt\": â€¦} lines found")
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return nil, err
	}
	run.EvalSetCount = count
	if err := WriteRun(run); err != nil {
		return nil, err
	}
	return run, nil
}

// normalizePrompts strips empty lines + trims whitespace per line.
// Returns the cleaned content + the count of non-empty lines.
func normalizePrompts(content string) (string, int) {
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		lines = append(lines, trimmed)
	}
	return strings.Join(lines, "\n") + "\n", len(lines)
}

// â”€â”€â”€ Run IDs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// newRunID returns a short, sortable, URL-safe identifier.
// Format: YYYYMMDD-HHMMSS-<6 hex>. Sortable, human-recognizable, no
// collisions in practice unless the user smashes the Create button
// inside the same millisecond â€” guarded by a process-local mutex
// would be overkill for a desktop app.
func newRunID() string {
	now := time.Now().UTC()
	return fmt.Sprintf("%s-%06x",
		now.Format("20060102-150405"),
		now.UnixNano()&0xFFFFFF)
}

func validRunID(id string) bool {
	// Format: "YYYYMMDD-HHMMSS-<6 hex>"
	if len(id) != 22 {
		return false
	}
	if id[8] != '-' || id[15] != '-' {
		return false
	}
	for i, c := range id {
		if i == 8 || i == 15 {
			continue
		}
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
