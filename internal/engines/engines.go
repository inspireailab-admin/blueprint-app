// Package engines defines the contract every inference runtime must
// satisfy so the supervisor can drive llama.cpp, vLLM, TensorRT-LLM
// (and any future addition) through one code path.
//
// Today only LlamaCpp is fully implemented; VLLM and TensorRTLLM are
// stubbed with NotImplemented errors. The interface exists so the
// supervisor isn't a hard refactor when those land — config gains an
// `engine` field, the supervisor calls engines.Get(cfg.Engine), and
// everything else follows.
package engines

import (
	"fmt"
	"strconv"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
	"github.com/inspireailab-admin/blueprint/pkg/runtime"
)

// ID constants the supervisor + UI use to identify engines.
const (
	IDLlamaCpp     = "llama-cpp"
	IDVLLM         = "vllm"
	IDTensorRTLLM  = "trt-llm"
)

// Info is the catalog entry the UI renders in an engine picker.
// Stable subset of an Engine's surface — doesn't require knowing the
// concrete type to display.
type Info struct {
	ID            string `json:"id"`
	DisplayName   string `json:"displayName"`
	Description   string `json:"description"`
	Implemented   bool   `json:"implemented"`
	Recommendation string `json:"recommendation"`
}

// Engine is the contract. Implementations encapsulate per-engine
// binary lookup, args generation, and endpoint URLs.
type Engine interface {
	// ID returns the stable engine identifier.
	ID() string

	// Info returns the display catalog entry.
	Info() Info

	// Binary returns the absolute path to the engine executable, or
	// an error if it isn't installed. The supervisor uses this in
	// exec.Command.
	Binary() (string, error)

	// Args translates the shared svcconfig.Config into the
	// engine-specific CLI args.
	Args(cfg *svcconfig.Config) []string

	// HealthURL is the URL the supervisor polls to know when the
	// engine has finished loading and is ready to serve.
	HealthURL(cfg *svcconfig.Config) string

	// MetricsURL is the URL the Dashboard scrapes for performance
	// counters. Returns "" when the engine doesn't expose metrics.
	MetricsURL(cfg *svcconfig.Config) string
}

// Get returns the Engine for the given ID. Empty or unknown values
// resolve to LlamaCpp — it's the default and the only one currently
// shipping a real implementation, so this is the safe fallback.
func Get(id string) Engine {
	switch id {
	case IDVLLM:
		return &VLLM{}
	case IDTensorRTLLM:
		return &TensorRTLLM{}
	case IDLlamaCpp, "":
		fallthrough
	default:
		return &LlamaCpp{}
	}
}

// All returns the catalog the UI displays in a picker.
func All() []Info {
	return []Info{
		(&LlamaCpp{}).Info(),
		(&VLLM{}).Info(),
		(&TensorRTLLM{}).Info(),
	}
}

// ─── llama.cpp ─────────────────────────────────────────────────────────────

// LlamaCpp is the default engine — the in-process supervisor uses it,
// the Calibrate workflow's eval harness uses it. Single binary,
// single GGUF, no Python dependency.
type LlamaCpp struct{}

func (LlamaCpp) ID() string { return IDLlamaCpp }

func (LlamaCpp) Info() Info {
	return Info{
		ID:            IDLlamaCpp,
		DisplayName:   "llama.cpp",
		Description:   "Single-binary local inference engine. GGUF weights, runs on CPU + any GPU. Default and the only engine currently implemented.",
		Implemented:   true,
		Recommendation: "Always available. Best for laptops, single-host on-prem, anyone who wants a single bundled binary.",
	}
}

func (LlamaCpp) Binary() (string, error) {
	return runtime.Find()
}

func (LlamaCpp) Args(cfg *svcconfig.Config) []string {
	args := []string{
		"--model", cfg.ModelPath,
		"--host", cfg.BindHost,
		"--port", strconv.Itoa(cfg.Port),
		"--ctx-size", strconv.Itoa(cfg.CtxSize),
		"--n-gpu-layers", strconv.Itoa(cfg.NGpuLayers),
	}
	if cfg.APIKey != "" {
		args = append(args, "--api-key", cfg.APIKey)
	}
	if cfg.EnableMetrics {
		args = append(args, "--metrics")
	}
	if cfg.Threads > 0 {
		args = append(args, "--threads", strconv.Itoa(cfg.Threads))
	}
	if cfg.BatchSize > 0 {
		args = append(args, "--batch-size", strconv.Itoa(cfg.BatchSize))
	}
	if cfg.UBatchSize > 0 {
		args = append(args, "--ubatch-size", strconv.Itoa(cfg.UBatchSize))
	}
	if cfg.FlashAttn {
		args = append(args, "--flash-attn")
	}
	if cfg.MemoryLock {
		args = append(args, "--mlock")
	}
	if cfg.NoMmap {
		args = append(args, "--no-mmap")
	}
	if cfg.ParallelSlots > 0 {
		args = append(args, "--parallel", strconv.Itoa(cfg.ParallelSlots))
	}
	if cfg.ContBatching {
		args = append(args, "--cont-batching")
	}
	if cfg.KvCacheTypeK != "" {
		args = append(args, "--cache-type-k", cfg.KvCacheTypeK)
	}
	if cfg.KvCacheTypeV != "" {
		args = append(args, "--cache-type-v", cfg.KvCacheTypeV)
	}
	if cfg.LogVerbose {
		args = append(args, "--verbose")
	}
	if cfg.LoraAdapter != "" {
		scale := cfg.LoraScale
		if scale <= 0 {
			scale = 1.0
		}
		args = append(args, "--lora-scaled", cfg.LoraAdapter, strconv.FormatFloat(scale, 'f', -1, 64))
	}
	return args
}

func (LlamaCpp) HealthURL(cfg *svcconfig.Config) string {
	return fmt.Sprintf("http://127.0.0.1:%d/health", cfg.Port)
}

func (LlamaCpp) MetricsURL(cfg *svcconfig.Config) string {
	if !cfg.EnableMetrics {
		return ""
	}
	return fmt.Sprintf("http://127.0.0.1:%d/metrics", cfg.Port)
}

// ─── vLLM (stub) ──────────────────────────────────────────────────────────

// VLLM is the placeholder for the vLLM Python-side engine. Binary()
// returns ErrNotImplemented until we wire the Python sidecar in a
// later turn.
type VLLM struct{}

func (VLLM) ID() string { return IDVLLM }

func (VLLM) Info() Info {
	return Info{
		ID:            IDVLLM,
		DisplayName:   "vLLM",
		Description:   "Python-side high-throughput engine with PagedAttention. Best on GPU-rich servers where llama.cpp leaves throughput on the table.",
		Implemented:   false,
		Recommendation: "Production GPU workloads (A100, H100, L40S). Requires Python + CUDA wheels.",
	}
}

func (VLLM) Binary() (string, error)        { return "", ErrNotImplemented }
func (VLLM) Args(*svcconfig.Config) []string { return nil }
func (VLLM) HealthURL(*svcconfig.Config) string {
	return ""
}
func (VLLM) MetricsURL(*svcconfig.Config) string {
	return ""
}

// ─── TensorRT-LLM (stub) ──────────────────────────────────────────────────

// TensorRTLLM is the placeholder for the NVIDIA-side TensorRT-LLM
// engine. Requires a pre-built engine plan (.engine file) tied to a
// specific GPU model and batch size.
type TensorRTLLM struct{}

func (TensorRTLLM) ID() string { return IDTensorRTLLM }

func (TensorRTLLM) Info() Info {
	return Info{
		ID:            IDTensorRTLLM,
		DisplayName:   "TensorRT-LLM",
		Description:   "NVIDIA's compiled engine plan. Highest absolute throughput on H100/H200 but rigid: engine is locked to one GPU model + batch shape.",
		Implemented:   false,
		Recommendation: "Maxing out a specific H100 deployment with a fixed batch profile.",
	}
}

func (TensorRTLLM) Binary() (string, error)        { return "", ErrNotImplemented }
func (TensorRTLLM) Args(*svcconfig.Config) []string { return nil }
func (TensorRTLLM) HealthURL(*svcconfig.Config) string {
	return ""
}
func (TensorRTLLM) MetricsURL(*svcconfig.Config) string {
	return ""
}

// ErrNotImplemented is the sentinel stub engines return from Binary().
// Callers should check for it and surface a clear "engine not yet
// implemented" message rather than treating it as a runtime crash.
var ErrNotImplemented = fmt.Errorf("engine not yet implemented")
