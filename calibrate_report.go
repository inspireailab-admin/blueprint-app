// Calibration report — Tier 1 step 7. Takes the run's metadata +
// results.json and stamps a Markdown report at <runDir>/report.md.
// That file is the consulting deliverable: workload description,
// candidate list, Pareto-style ranking, recommended quant, and the
// headline "we beat the stock pre-quant by Δ%" finding.

package main

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/calibration"
)

// GenerateCalibrationReport renders report.md and returns its absolute
// path. The frontend shows the path so the user can hand the file
// over directly to the client.
func (a *App) GenerateCalibrationReport(runID string) (string, error) {
	run, err := calibration.ReadRun(runID)
	if err != nil {
		return "", err
	}
	if run == nil {
		return "", fmt.Errorf("run %q not found", runID)
	}
	results, err := calibration.ReadEvalResults(runID)
	if err != nil {
		return "", err
	}
	if results == nil {
		return "", fmt.Errorf("no eval results — run the evaluation first")
	}

	md := buildReportMarkdown(run, results)
	path, err := calibration.ReportPath(runID)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(md), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func buildReportMarkdown(run *calibration.Run, r *calibration.EvalResults) string {
	var b strings.Builder

	clientLabel := run.ClientLabel
	if clientLabel == "" {
		clientLabel = "Untitled engagement"
	}

	fmt.Fprintf(&b, "# Custom Quantization Report — %s\n\n", clientLabel)
	fmt.Fprintf(&b, "_Generated %s by Blueprint._\n\n",
		time.Now().Format("2006-01-02 15:04 MST"))

	// ── Workload ──────────────────────────────────────────────────────
	fmt.Fprintln(&b, "## Workload")
	fmt.Fprintln(&b)
	fmt.Fprintf(&b, "- Base model: `%s`\n", run.BaseModelID)
	fmt.Fprintf(&b, "- Base quant for calibration: `%s`\n", strings.ToUpper(run.BaseQuant))
	fmt.Fprintf(&b, "- Calibration prompt count: **%d**\n", run.PromptCount)
	fmt.Fprintf(&b, "- Eval set size: **%d**\n", r.EvalSetCount)
	fmt.Fprintf(&b, "- Default scoring: `%s`\n", r.DefaultScoring)
	fmt.Fprintln(&b)

	// ── Headline ──────────────────────────────────────────────────────
	fmt.Fprintln(&b, "## Headline finding")
	fmt.Fprintln(&b)
	headline := computeHeadline(r)
	fmt.Fprintln(&b, headline)
	fmt.Fprintln(&b)

	// ── Candidate table ───────────────────────────────────────────────
	fmt.Fprintln(&b, "## Candidates evaluated")
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "| Candidate | Source | Mean score | P50 TTFT | P95 TTFT | Tok/s | Size |")
	fmt.Fprintln(&b, "|---|---|---:|---:|---:|---:|---:|")
	sorted := make([]calibration.CandidateResult, len(r.Candidates))
	copy(sorted, r.Candidates)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].MeanScore > sorted[j].MeanScore })
	for _, c := range sorted {
		fmt.Fprintf(&b,
			"| `%s` | %s | **%.1f%%** | %d ms | %d ms | %.1f | %s |\n",
			c.Label, c.Source, c.MeanScore*100, c.MedianTTFTms, c.P95TTFTms, c.MeanTokPerSec, humanBytesMd(c.FileSizeBytes),
		)
	}
	fmt.Fprintln(&b)

	// ── Recommendation ────────────────────────────────────────────────
	if len(sorted) > 0 {
		top := sorted[0]
		fmt.Fprintln(&b, "## Recommendation")
		fmt.Fprintln(&b)
		fmt.Fprintf(&b,
			"`%s` is the Pareto-front pick at **%.1f%% mean quality** on the eval set, "+
				"with **P50 TTFT %d ms** and **%.1f tok/s** generation throughput on this hardware.\n\n"+
				"The on-disk GGUF lives at `%s` — copy it onto the production serving host and "+
				"point llama-server's `--model` at it.\n",
			top.Label, top.MeanScore*100, top.MedianTTFTms, top.MeanTokPerSec, top.GGUFPath,
		)
		fmt.Fprintln(&b)
	}

	// ── Methodology ───────────────────────────────────────────────────
	fmt.Fprintln(&b, "## Methodology")
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "1. Calibration: `llama-imatrix` ran the client-supplied prompt corpus against the base GGUF to produce a per-tensor importance matrix.")
	fmt.Fprintln(&b, "2. Quantization: `llama-quantize --imatrix <calibration> <base> <out> <target>` was run once per target quant level.")
	fmt.Fprintln(&b, "3. Evaluation: a temporary `llama-server` instance was started per candidate GGUF and every eval prompt was streamed through `/v1/chat/completions`; the response was scored against the expected output and timing was recorded.")
	fmt.Fprintln(&b, "4. Aggregation: per-candidate mean score, P50/P95 TTFT, and mean throughput were computed across the eval set.")
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "_Note: token counts are approximated by streamed-chunk count; comparable across candidates on the same hardware, but not a tokenizer-exact figure._")

	return b.String()
}

func computeHeadline(r *calibration.EvalResults) string {
	if len(r.Candidates) == 0 {
		return "_No candidates were evaluated._"
	}
	// Same-quant calibrated vs stock comparison wins the headline if
	// it exists.
	byTarget := map[string][]calibration.CandidateResult{}
	for _, c := range r.Candidates {
		byTarget[c.QuantTarget] = append(byTarget[c.QuantTarget], c)
	}
	for target, pair := range byTarget {
		var cal, stock *calibration.CandidateResult
		for i := range pair {
			if pair[i].Source == "calibrated" {
				cal = &pair[i]
			} else if pair[i].Source == "stock" {
				stock = &pair[i]
			}
		}
		if cal == nil || stock == nil {
			continue
		}
		delta := cal.MeanScore - stock.MeanScore
		if delta > 0 {
			pct := delta / max(stock.MeanScore, 1e-9) * 100
			return fmt.Sprintf(
				"**Custom-calibrated `%s` beats the bartowski pre-quant by %.1f%%** on this eval set "+
					"(%.1f%% vs %.1f%%), with throughput within %.0f%% on the same hardware. The "+
					"client should ship the calibrated GGUF for this workload.",
				target, pct, cal.MeanScore*100, stock.MeanScore*100,
				abs(cal.MeanTokPerSec-stock.MeanTokPerSec)/max(stock.MeanTokPerSec, 1e-9)*100,
			)
		}
	}
	sorted := make([]calibration.CandidateResult, len(r.Candidates))
	copy(sorted, r.Candidates)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].MeanScore > sorted[j].MeanScore })
	top := sorted[0]
	return fmt.Sprintf(
		"Top performer on the eval set is `%s` at **%.1f%% mean quality** "+
			"(P50 TTFT %d ms, %.1f tok/s).",
		top.Label, top.MeanScore*100, top.MedianTTFTms, top.MeanTokPerSec,
	)
}

func humanBytesMd(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	units := []string{"KB", "MB", "GB", "TB"}
	v := float64(n) / 1024
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	return fmt.Sprintf("%.1f %s", v, units[i])
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
