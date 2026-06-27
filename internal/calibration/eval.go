// Eval pipeline — types, scorers, and the persistence layer for
// step 5 of the calibration workflow.
//
// One EvalRun produces one results.json per Run directory containing
// per-candidate measurements: quality (mean score on the eval set),
// throughput (tokens/sec generation), TTFT (P50 + P95), and the
// per-prompt detail so a future deep-dive surface can show "which
// prompts moved when we switched from Q4_K_M to IQ4_XS."
//
// Author: Amar Mond.
package calibration

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Scoring is how an eval row's predicted output is graded against the
// expected. Two implementations land in this turn (exact + ROUGE-L);
// "judge" mode using an LLM grader is reserved for a future iteration.
type Scoring string

const (
	ScoringExact  Scoring = "exact"   // normalized literal match -> 0 or 1
	ScoringRougeL Scoring = "rouge-l" // ROUGE-L F1 (token-level LCS)
)

// EvalEntry is one row of the user-uploaded JSONL eval set.
// Each line of eval.jsonl must parse to this shape; "prompt" is
// required and "expected" is required for grading.
type EvalEntry struct {
	Prompt   string  `json:"prompt"`
	Expected string  `json:"expected"`
	Scoring  Scoring `json:"scoring,omitempty"` // overrides the run-level default if set
}

// PromptResult captures one (candidate × prompt) measurement.
type PromptResult struct {
	Prompt        string  `json:"prompt"`
	Expected      string  `json:"expected"`
	Predicted     string  `json:"predicted"`
	Score         float64 `json:"score"`         // 0..1
	TTFTms        int64   `json:"ttftMs"`        // time-to-first-token
	GenTokens     int     `json:"genTokens"`     // tokens in the predicted output
	GenSeconds    float64 `json:"genSeconds"`    // wall-clock for the streamed reply
	TokensPerSec  float64 `json:"tokensPerSec"`  // genTokens / genSeconds
	Error         string  `json:"error,omitempty"`
}

// CandidateResult aggregates PromptResults for one GGUF candidate.
// Source describes where the GGUF came from: "calibrated" (this run's
// custom output) or "stock" (the bartowski-published pre-quant).
type CandidateResult struct {
	Label         string         `json:"label"`         // human label, e.g. "Q4_K_M (calibrated)"
	Source        string         `json:"source"`        // "calibrated" | "stock"
	QuantTarget   string         `json:"quantTarget"`   // "Q4_K_M" etc
	GGUFPath      string         `json:"ggufPath"`
	FileSizeBytes int64          `json:"fileSizeBytes"` // disk footprint, proxy for VRAM
	MeanScore     float64        `json:"meanScore"`     // 0..1 mean quality
	MedianTTFTms  int64          `json:"medianTTFTms"`
	P95TTFTms     int64          `json:"p95TTFTms"`
	MeanTokPerSec float64        `json:"meanTokPerSec"`
	NumScored     int            `json:"numScored"`
	NumFailed     int            `json:"numFailed"`
	Rows          []PromptResult `json:"rows"`
}

// EvalResults is the full results.json for a calibration run.
type EvalResults struct {
	StartedAtMs    int64             `json:"startedAtMs"`
	FinishedAtMs   int64             `json:"finishedAtMs"`
	DefaultScoring Scoring           `json:"defaultScoring"`
	EvalSetCount   int               `json:"evalSetCount"`
	Candidates     []CandidateResult `json:"candidates"`
}

// ReadEvalResults loads results.json. Returns (nil, nil) when missing
// — the sentinel for "eval hasn't run yet."
func ReadEvalResults(runID string) (*EvalResults, error) {
	path, err := EvalResultsPath(runID)
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
	var r EvalResults
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// WriteEvalResults persists results.json.
func WriteEvalResults(runID string, r *EvalResults) error {
	path, err := EvalResultsPath(runID)
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

// ReadEvalSet parses eval.jsonl. Skips empty lines and lines that
// fail to parse (best-effort; the upload validates strictly).
func ReadEvalSet(runID string) ([]EvalEntry, error) {
	path, err := EvalSetPath(runID)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := make([]EvalEntry, 0, 64)
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var e EvalEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		if e.Prompt == "" {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// ─── Scoring implementations ───────────────────────────────────────────────

// ScoreFor returns a 0..1 quality score for predicted vs expected
// under the chosen scoring mode. Empty expected -> 0 (can't grade).
func ScoreFor(mode Scoring, predicted, expected string) float64 {
	if expected == "" {
		return 0
	}
	switch mode {
	case ScoringExact:
		return scoreExact(predicted, expected)
	case ScoringRougeL:
		return scoreRougeL(predicted, expected)
	default:
		return scoreRougeL(predicted, expected)
	}
}

var whitespace = regexp.MustCompile(`\s+`)
var punct = regexp.MustCompile(`[\p{P}\p{S}]`)

// scoreExact normalizes (lowercase, strip punctuation, collapse
// whitespace) and returns 1 on full match, 0 otherwise.
func scoreExact(a, b string) float64 {
	if normalize(a) == normalize(b) {
		return 1.0
	}
	return 0.0
}

func normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = punct.ReplaceAllString(s, "")
	s = whitespace.ReplaceAllString(s, " ")
	return s
}

// scoreRougeL computes ROUGE-L F1: the longest common subsequence of
// tokens, divided by predicted length (precision) and expected length
// (recall), combined as F1. Token = whitespace-separated word after
// normalize().
func scoreRougeL(a, b string) float64 {
	aTok := strings.Fields(normalize(a))
	bTok := strings.Fields(normalize(b))
	if len(aTok) == 0 || len(bTok) == 0 {
		return 0
	}
	lcs := lcsLen(aTok, bTok)
	if lcs == 0 {
		return 0
	}
	precision := float64(lcs) / float64(len(aTok))
	recall := float64(lcs) / float64(len(bTok))
	if precision+recall == 0 {
		return 0
	}
	return 2 * precision * recall / (precision + recall)
}

func lcsLen(a, b []string) int {
	if len(a) > len(b) {
		a, b = b, a
	}
	// Rolling 1D DP — O(len(b)) space.
	prev := make([]int, len(a)+1)
	curr := make([]int, len(a)+1)
	for j := 1; j <= len(b); j++ {
		for i := 1; i <= len(a); i++ {
			if a[i-1] == b[j-1] {
				curr[i] = prev[i-1] + 1
			} else if prev[i] >= curr[i-1] {
				curr[i] = prev[i]
			} else {
				curr[i] = curr[i-1]
			}
		}
		prev, curr = curr, prev
		for i := range curr {
			curr[i] = 0
		}
	}
	return prev[len(a)]
}

// Percentile returns the p-th percentile of a sorted int64 slice
// (linear interpolation between adjacent ranks). 0..100 inputs.
func Percentile(sorted []int64, p float64) int64 {
	if len(sorted) == 0 {
		return 0
	}
	if p <= 0 {
		return sorted[0]
	}
	if p >= 100 {
		return sorted[len(sorted)-1]
	}
	rank := (p / 100) * float64(len(sorted)-1)
	lo := int(rank)
	hi := lo + 1
	if hi >= len(sorted) {
		return sorted[lo]
	}
	frac := rank - float64(lo)
	return int64(float64(sorted[lo])*(1-frac) + float64(sorted[hi])*frac)
}

// SortedCopy returns a sorted copy of the slice (small helper to keep
// callers concise).
func SortedCopy(xs []int64) []int64 {
	out := make([]int64, len(xs))
	copy(out, xs)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
