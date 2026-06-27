// Engine IPC surface — minimal for now since only llama-cpp is wired
// end-to-end. The frontend lists engines so users can SEE that vLLM
// and TensorRT-LLM are on the roadmap and confirm which one is in
// flight today.
//
// Author: Amar Mond.
package main

import "github.com/inspireailab-admin/blueprint-app/internal/engines"

// ListEngines returns the catalog of known inference engines. Each
// entry reports whether it's currently implemented or stubbed.
func (a *App) ListEngines() []engines.Info {
	return engines.All()
}
