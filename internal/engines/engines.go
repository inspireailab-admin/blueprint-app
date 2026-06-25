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
	"os"
	"strconv"

	"github.com/inspireailab-admin/blueprint-app/internal/pyruntime"
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

// VLLM wraps the vLLM Python OpenAI-compatible server. The actual
// engine is `python -m vllm.entrypoints.openai.api_server` running in
// our managed venv. We supervise it the same way we supervise
// llama-server.
//
// Caveat: vLLM expects a HuggingFace model identifier in
// cfg.ModelPath (e.g. "meta-llama/Llama-3.2-3B-Instruct"), NOT a GGUF
// path. vLLM downloads/caches via HF_HOME. We set HF_HOME to
// ~/.blueprint/hf-cache so downloads stay scoped to Blueprint's data
// dir, but the catalog/Plan flow doesn't currently surface vLLM-
// flavored model picking — for now the user manually picks the
// engine + sets ModelPath to a HF identifier. A future ModelPicker
// in ServiceCard will gate the engine choice on a per-model basis.
type VLLM struct{}

func (VLLM) ID() string { return IDVLLM }

func (VLLM) Info() Info {
	implemented := pyruntime.IsInstalled(pyruntime.FeatureVLLM)
	return Info{
		ID:             IDVLLM,
		DisplayName:    "vLLM",
		Description:    "Python-side high-throughput engine with PagedAttention. Best on GPU-rich servers where llama.cpp leaves throughput on the table.",
		Implemented:    implemented,
		Recommendation: "Production GPU workloads (A100, H100, L40S). Install the vLLM feature from the Dashboard's Python runtime card.",
	}
}

// Binary returns the venv python — vLLM runs via `python -m
// vllm.entrypoints.openai.api_server`.
func (VLLM) Binary() (string, error) {
	if !pyruntime.IsInstalled(pyruntime.FeatureVLLM) {
		return "", fmt.Errorf("vLLM feature is not installed — install it via the Dashboard's Python runtime card")
	}
	bin, err := pyruntime.VenvPython()
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(bin); err != nil {
		return "", fmt.Errorf("venv python missing at %s — reinstall the Python runtime (Python core feature)", bin)
	}
	return bin, nil
}

// Args translates svcconfig.Config into vLLM's CLI flags.
//
// Mappings:
//
//	cfg.ModelPath      → --model            (HuggingFace identifier)
//	cfg.BindHost       → --host
//	cfg.Port           → --port
//	cfg.APIKey         → --api-key
//	cfg.CtxSize        → --max-model-len
//	cfg.NGpuLayers     → ignored (vLLM uses --tensor-parallel-size for multi-GPU)
//	cfg.ParallelSlots  → --max-num-seqs     (concurrent decode slots)
//	cfg.BatchSize      → --max-num-batched-tokens
//	cfg.KvCacheTypeK   → --kv-cache-dtype   (when "q8_0" we map to "fp8", others ignored — vLLM has narrower options)
//
// Everything not listed is silently ignored — vLLM has its own
// defaults that are sensible for GPU serving.
func (VLLM) Args(cfg *svcconfig.Config) []string {
	args := []string{
		"-m", "vllm.entrypoints.openai.api_server",
		"--model", cfg.ModelPath,
		"--host", cfg.BindHost,
		"--port", strconv.Itoa(cfg.Port),
	}
	if cfg.APIKey != "" {
		args = append(args, "--api-key", cfg.APIKey)
	}
	if cfg.CtxSize > 0 {
		args = append(args, "--max-model-len", strconv.Itoa(cfg.CtxSize))
	}
	if cfg.ParallelSlots > 0 {
		args = append(args, "--max-num-seqs", strconv.Itoa(cfg.ParallelSlots))
	}
	if cfg.BatchSize > 0 {
		args = append(args, "--max-num-batched-tokens", strconv.Itoa(cfg.BatchSize))
	}
	switch cfg.KvCacheTypeK {
	case "q8_0":
		// vLLM doesn't accept "q8_0"; closest is "fp8".
		args = append(args, "--kv-cache-dtype", "fp8")
	}
	return args
}

// HealthURL — vLLM exposes /health on the same port.
func (VLLM) HealthURL(cfg *svcconfig.Config) string {
	return fmt.Sprintf("http://127.0.0.1:%d/health", cfg.Port)
}

// MetricsURL — vLLM exposes Prometheus metrics at /metrics.
func (VLLM) MetricsURL(cfg *svcconfig.Config) string {
	return fmt.Sprintf("http://127.0.0.1:%d/metrics", cfg.Port)
}

// ─── TensorRT-LLM (stub) ──────────────────────────────────────────────────

// TensorRTLLM wraps NVIDIA's TensorRT-LLM OpenAI-compatible server.
// The actual command is `python -m tensorrt_llm.serve` (the 0.13+
// API) pointing at a pre-built engine plan + the model's tokenizer
// directory.
//
// Two caveats specific to this engine:
//
//   1. Engine plans are GPU-specific. An engine built for H100 won't
//      run on A100. The user is responsible for running trtllm-build
//      first; we don't generate engine plans inside Blueprint (yet).
//      cfg.ModelPath here is the path to the engine plan directory,
//      NOT a HF identifier or GGUF.
//
//   2. The companion tokenizer must live next to (or be specified
//      alongside) the engine plan. cfg.LoraAdapter is repurposed as
//      the tokenizer directory path when engine=trt-llm — same idea
//      as vLLM repurposing ModelPath to HF identifier.
type TensorRTLLM struct{}

func (TensorRTLLM) ID() string { return IDTensorRTLLM }

func (TensorRTLLM) Info() Info {
	implemented := pyruntime.IsInstalled(pyruntime.FeatureTensorRTLLM)
	return Info{
		ID:             IDTensorRTLLM,
		DisplayName:    "TensorRT-LLM",
		Description:    "NVIDIA's compiled engine plan. Highest absolute throughput on H100/H200 but rigid: engine is locked to one GPU model + batch shape. Requires running trtllm-build first to produce the .engine plan.",
		Implemented:    implemented,
		Recommendation: "Maxing out a specific H100/H200 deployment with a fixed batch profile. Install the TensorRT-LLM feature from the Dashboard's Python runtime card.",
	}
}

// Binary returns the venv python — TRT-LLM runs via
// `python -m tensorrt_llm.serve`.
func (TensorRTLLM) Binary() (string, error) {
	if !pyruntime.IsInstalled(pyruntime.FeatureTensorRTLLM) {
		return "", fmt.Errorf("TensorRT-LLM feature is not installed — install it via the Dashboard's Python runtime card")
	}
	bin, err := pyruntime.VenvPython()
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(bin); err != nil {
		return "", fmt.Errorf("venv python missing at %s — reinstall the Python runtime (Python core feature)", bin)
	}
	return bin, nil
}

// Args translates svcconfig.Config into TRT-LLM serve flags.
//
// Mappings:
//
//	cfg.ModelPath      → --model_dir       (engine plan directory)
//	cfg.LoraAdapter    → --tokenizer_dir   (repurposed; see struct doc)
//	cfg.BindHost       → --host
//	cfg.Port           → --port
//	cfg.ParallelSlots  → --max_batch_size
//	cfg.BatchSize      → --max_num_tokens
//
// TRT-LLM's serve subcommand has fewer knobs than vLLM because most
// of the tuning happens at engine-build time (trtllm-build), not at
// serve time.
func (TensorRTLLM) Args(cfg *svcconfig.Config) []string {
	args := []string{
		"-m", "tensorrt_llm.serve",
		"--model_dir", cfg.ModelPath,
		"--host", cfg.BindHost,
		"--port", strconv.Itoa(cfg.Port),
	}
	if cfg.LoraAdapter != "" {
		// In TRT-LLM mode this field is repurposed for the tokenizer
		// directory — see struct doc.
		args = append(args, "--tokenizer_dir", cfg.LoraAdapter)
	}
	if cfg.ParallelSlots > 0 {
		args = append(args, "--max_batch_size", strconv.Itoa(cfg.ParallelSlots))
	}
	if cfg.BatchSize > 0 {
		args = append(args, "--max_num_tokens", strconv.Itoa(cfg.BatchSize))
	}
	return args
}

// HealthURL — TRT-LLM's serve exposes /health.
func (TensorRTLLM) HealthURL(cfg *svcconfig.Config) string {
	return fmt.Sprintf("http://127.0.0.1:%d/health", cfg.Port)
}

// MetricsURL — TRT-LLM doesn't expose Prometheus metrics by default.
// Returning empty means the Dashboard's metrics card stays blank when
// this engine is selected (which is the honest behaviour).
func (TensorRTLLM) MetricsURL(*svcconfig.Config) string {
	return ""
}

// ErrNotImplemented is the sentinel stub engines return from Binary().
// Callers should check for it and surface a clear "engine not yet
// implemented" message rather than treating it as a runtime crash.
var ErrNotImplemented = fmt.Errorf("engine not yet implemented")
