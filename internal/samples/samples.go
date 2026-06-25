// Package samples bundles ready-to-run calibration datasets so a new
// user can walk the full Calibrate pipeline end-to-end without
// authoring 100+ prompts by hand. Each dataset is engineered to
// produce a measurable "custom-calibrated beats stock" delta on the
// resulting Pareto chart, which is the consulting pitch's punchline.
//
// Datasets ship inside the binary via go:embed and are shelled out to
// a calibration run directory when the user clicks "Load sample" in
// the Calibrate tab. The Run's ClientLabel is prefixed "DEMO — " so
// real engagements stay visually distinct from practice runs.
package samples

import (
	"embed"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

//go:embed data/*/*
var sampleFS embed.FS

// Sample is one bundled dataset. The frontend renders these as cards
// in the "Load sample" picker; the backend uses them to seed a Run.
type Sample struct {
	ID          string `json:"id"`          // url-safe identifier — used as directory name under data/
	Name        string `json:"name"`        // display name on the picker card
	Summary     string `json:"summary"`     // 1-sentence pitch shown on the card
	Description string `json:"description"` // longer markdown shown in a detail pane
	Domain      string `json:"domain"`      // e.g. "Customer support", "SQL generation"
	Scoring     string `json:"scoring"`     // "exact" | "rouge-l" — what the harness should use
	BaseModelID string `json:"baseModelId"` // catalog model id this demo anchors on
	BaseQuant   string `json:"baseQuant"`   // recommended source quant for calibration (typically "q8")
	Targets     []string `json:"targets"`    // recommended target quants for quantize step
}

// All returns the catalog of bundled datasets. Order matters — it
// drives the order on the picker, so the polished one comes first.
func All() []Sample {
	return []Sample{
		{
			ID:          "support-intent",
			Name:        "Customer-support intent (Stellaron Cloud)",
			Summary:     "Classify support messages into 10 intents for a fictional SaaS product. Engineered to highlight custom calibration's edge on company-specific vocabulary.",
			Description: descFor("support-intent"),
			Domain:      "Customer support · classification",
			Scoring:     "exact",
			BaseModelID: "llama-3.2-3b-instruct",
			BaseQuant:   "q8",
			Targets:     []string{"IQ4_XS", "Q4_K_M"},
		},
		{
			ID:          "sql-apex",
			Name:        "SQL generation (Apex Manufacturing)",
			Summary:     "Translate natural-language questions into SQL against a fictional manufacturing schema. Tests the model on a domain-specific table shape it has never seen.",
			Description: descFor("sql-apex"),
			Domain:      "Code generation · SQL",
			Scoring:     "rouge-l",
			BaseModelID: "llama-3.2-3b-instruct",
			BaseQuant:   "q8",
			Targets:     []string{"IQ4_XS", "Q4_K_M"},
		},
		{
			ID:          "contract-qa",
			Name:        "Contract clause Q&A (Vesper Indemnity)",
			Summary:     "Short-form questions about a fictional insurance indemnity policy. Demonstrates the consulting story on specialized policy language.",
			Description: descFor("contract-qa"),
			Domain:      "Legal / insurance · short-form Q&A",
			Scoring:     "rouge-l",
			BaseModelID: "llama-3.2-3b-instruct",
			BaseQuant:   "q8",
			Targets:     []string{"IQ4_XS", "Q4_K_M"},
		},
	}
}

// Get returns the Sample with a given ID, or an error.
func Get(id string) (*Sample, error) {
	for _, s := range All() {
		if s.ID == id {
			return &s, nil
		}
	}
	return nil, fmt.Errorf("sample %q not found", id)
}

// LoadPrompts returns the calibration corpus for a sample (plain text,
// one prompt per line).
func LoadPrompts(id string) (string, error) {
	return readFile(id, "prompts.txt")
}

// LoadEvalSet returns the JSONL eval set for a sample.
func LoadEvalSet(id string) (string, error) {
	return readFile(id, "eval.jsonl")
}

// LoadReadme returns the per-sample README explaining the workload
// and the expected calibration win.
func LoadReadme(id string) (string, error) {
	return readFile(id, "README.md")
}

func readFile(id, name string) (string, error) {
	path := filepath.ToSlash(filepath.Join("data", id, name))
	b, err := fs.ReadFile(sampleFS, path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	return string(b), nil
}

// descFor extracts the first non-heading paragraph from the README
// for the description field. Read once at All() call sites; failures
// fall back to the summary.
func descFor(id string) string {
	md, err := readFile(id, "README.md")
	if err != nil {
		return ""
	}
	var keep []string
	for _, line := range strings.Split(md, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, "---") {
			if len(keep) > 0 {
				break
			}
			continue
		}
		keep = append(keep, t)
	}
	return strings.Join(keep, " ")
}
