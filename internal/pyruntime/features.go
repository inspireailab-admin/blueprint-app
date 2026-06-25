// Package pyruntime owns Blueprint's optional Python sidecar: deciding
// what to install, checking disk space, driving uv to install/uninstall,
// and reporting status back to the UI.
//
// The architecture is uv-managed: we don't ship Python, we ship uv,
// and on first use we run `uv python install` + `uv pip install ...`.
// That keeps the Blueprint installer small (no 2 GB CUDA wheel in
// the download), and lets the user opt in to only the heavy bits they
// actually need.
//
// Three layers:
//
//   features.go  — the catalog: which features exist, what they need,
//                  how big they are. This file.
//   runtime.go   — state, install/uninstall orchestration, manifest
//                  persistence.
//   uv.go        — the actual uv subprocess invocations.
package pyruntime

// Feature is one user-visible install option.
type Feature struct {
	// ID is the stable identifier — never user-visible.
	ID string `json:"id"`

	// Name is what the user sees on the card.
	Name string `json:"name"`

	// Summary is the one-liner under the name.
	Summary string `json:"summary"`

	// Description is a longer pitch shown in the install confirm modal.
	Description string `json:"description"`

	// AddedSizeBytes is the marginal size when installing this feature
	// on top of an already-installed Python core. The UI sums these
	// when the user is picking multiple features so the total stays
	// honest.
	AddedSizeBytes int64 `json:"addedSizeBytes"`

	// RequiresGPU true means an NVIDIA GPU + driver must be present.
	// We show a clear warning if the user doesn't have one.
	RequiresGPU bool `json:"requiresGPU"`

	// Dependencies are other Feature IDs that must be installed first.
	// "python-core" is the root every other feature implicitly needs.
	Dependencies []string `json:"dependencies"`

	// PipPackages are the package specs that `uv pip install` gets.
	PipPackages []string `json:"pipPackages"`

	// IndexURL points at a non-PyPI index (e.g. PyTorch CUDA wheels
	// live at https://download.pytorch.org/whl/cu121). Empty = PyPI.
	IndexURL string `json:"indexURL,omitempty"`
}

// All returns the catalog of features, ordered for the UI.
//
// "python-core" is the foundation; it's an installable feature but
// the UI labels it as a prerequisite that gets installed automatically
// when the user picks anything else.
func All() []Feature {
	return []Feature{
		{
			ID:             FeaturePythonCore,
			Name:           "Python runtime (core)",
			Summary:        "uv-managed Python 3.11 + minimal sidecar libraries.",
			Description:    "Required by every other Python-side feature. Installed once and reused. Adds ~230 MB on disk.",
			AddedSizeBytes: 230 * MB,
			PipPackages:    []string{"fastapi", "uvicorn", "requests"},
		},
		{
			ID:             FeatureLLMLingua,
			Name:           "Prompt compression (LLMLingua)",
			Summary:        "Token-importance compression for long-context prompts.",
			Description:    "Adds the LLMLingua compressor + a small embedding model. CPU-only, works on any machine. Adds ~250 MB on disk.",
			AddedSizeBytes: 250 * MB,
			Dependencies:   []string{FeaturePythonCore},
			PipPackages:    []string{"llmlingua"},
		},
		{
			ID:             FeaturePyTorchCUDA,
			Name:           "PyTorch + CUDA 12.x",
			Summary:        "GPU compute stack — prerequisite for LoRA training, vLLM, TensorRT-LLM.",
			Description:    "PyTorch built against CUDA 12.1. Pulls one big wheel (~2.5 GB) — the bulk of the Python-side disk usage. Requires an NVIDIA GPU + a CUDA driver (the runtime is bundled with the wheel).",
			AddedSizeBytes: 2_500 * MB,
			RequiresGPU:    true,
			Dependencies:   []string{FeaturePythonCore},
			PipPackages:    []string{"torch", "torchvision", "torchaudio"},
			IndexURL:       "https://download.pytorch.org/whl/cu121",
		},
		{
			ID:             FeatureLoRATraining,
			Name:           "LoRA training pipeline",
			Summary:        "Fine-tune LoRA adapters on client data.",
			Description:    "transformers + peft + accelerate + bitsandbytes + trl + datasets. ~800 MB on top of PyTorch. Needs an NVIDIA GPU with 16+ GB VRAM for usable speed; 8 GB works for QLoRA on small models.",
			AddedSizeBytes: 800 * MB,
			RequiresGPU:    true,
			Dependencies:   []string{FeaturePythonCore, FeaturePyTorchCUDA},
			PipPackages:    []string{"transformers", "peft", "accelerate", "bitsandbytes", "trl", "datasets"},
		},
		{
			ID:             FeatureVLLM,
			Name:           "vLLM engine",
			Summary:        "High-throughput Python inference engine with PagedAttention.",
			Description:    "Best for production GPU servers (A100, H100, L40S). About 2× the throughput of llama.cpp on the same hardware for batch workloads. Adds ~1.2 GB on top of PyTorch.",
			AddedSizeBytes: 1_200 * MB,
			RequiresGPU:    true,
			Dependencies:   []string{FeaturePythonCore, FeaturePyTorchCUDA},
			PipPackages:    []string{"vllm"},
		},
		{
			ID:             FeatureTensorRTLLM,
			Name:           "TensorRT-LLM engine",
			Summary:        "NVIDIA's compiled engine plan for maximum throughput.",
			Description:    "Best on H100/H200 with a fixed batch profile — engine plans are GPU-model-specific. Adds ~2.0 GB on top of PyTorch. Requires the user to build an engine plan separately (trtllm-build) once Blueprint surfaces the workflow.",
			AddedSizeBytes: 2_000 * MB,
			RequiresGPU:    true,
			Dependencies:   []string{FeaturePythonCore, FeaturePyTorchCUDA},
			PipPackages:    []string{"tensorrt-llm"},
		},
	}
}

// Feature ID constants — exported so callers don't fat-finger the
// string literal.
const (
	FeaturePythonCore   = "python-core"
	FeatureLLMLingua    = "llmlingua"
	FeaturePyTorchCUDA  = "pytorch-cuda"
	FeatureLoRATraining = "lora-training"
	FeatureVLLM         = "vllm"
	FeatureTensorRTLLM  = "tensorrt-llm"
)

// Get returns a feature by ID, or nil + not-found.
func Get(id string) *Feature {
	for _, f := range All() {
		if f.ID == id {
			return &f
		}
	}
	return nil
}

// ResolveDependencies returns the feature plus every transitive
// dependency, ordered so dependencies come before dependants. The UI
// uses this to show "if you install LoRA training, here's what comes
// along" and to drive the install loop in order.
func ResolveDependencies(id string) []Feature {
	visited := make(map[string]bool)
	var order []Feature
	var visit func(string)
	visit = func(fid string) {
		if visited[fid] {
			return
		}
		visited[fid] = true
		f := Get(fid)
		if f == nil {
			return
		}
		for _, dep := range f.Dependencies {
			visit(dep)
		}
		order = append(order, *f)
	}
	visit(id)
	return order
}

// Size constants. Bytes are int64 because some of these get big.
const (
	KB = int64(1024)
	MB = 1024 * KB
	GB = 1024 * MB
)
