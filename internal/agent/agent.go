// Package agent is the remote-machine side of Blueprint enrollment. It dials
// the relay with a join code, secures the channel, and serves the control
// protocol against the local machine's Runtime (docs/plan-target-aware-deploy
// §4). The production Runtime wires to blueprint-svc / the kernel; this package
// itself depends only on the (pure) relay + control packages, so it builds and
// tests without the svc environment.
//
// Scope: this handles ONE enrollment session (the code is single-use). Durable
// reconnection for ongoing monitoring needs stable relay addressing — a
// follow-up increment.
package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/inspireailab-admin/blueprint-app/internal/control"
	"github.com/inspireailab-admin/blueprint-app/internal/relay"
)

// Control method names — shared by the agent (Handler) and desktop (Client).
const (
	MethodDetectHardware = "detect-hardware"
	MethodInstallRuntime = "install-runtime"
	MethodPullModel      = "pull-model"
	MethodServe          = "serve"
	MethodStop           = "stop"
	MethodStatus         = "status"
	MethodMetrics        = "metrics"
)

// ─── Wire types (JSON over the control protocol) ────────────────────────────

type GPU struct {
	Index       int    `json:"index"`
	Name        string `json:"name"`
	Vendor      string `json:"vendor"`
	VRAMTotalMB int    `json:"vramTotalMB"`
	VRAMFreeMB  int    `json:"vramFreeMB"`
}

type Hardware struct {
	OS         string  `json:"os"`
	CPUCores   int     `json:"cpuCores"`
	RAMTotalGB float64 `json:"ramTotalGB"`
	RAMFreeGB  float64 `json:"ramFreeGB"`
	GPUs       []GPU   `json:"gpus"`
}

// Progress is a streamed step update during install/pull.
type Progress struct {
	Stage  string `json:"stage"`
	Pct    int    `json:"pct"`
	Detail string `json:"detail,omitempty"`
}

type ServeSpec struct {
	ModelID     string    `json:"modelId"`
	Quant       string    `json:"quant"`
	CtxSize     int       `json:"ctxSize"`
	NGpuLayers  int       `json:"nGpuLayers"`
	SplitMode   string    `json:"splitMode,omitempty"`
	TensorSplit []float64 `json:"tensorSplit,omitempty"`
}

type ServeStatus struct {
	State    string `json:"state"` // running | starting | stopped
	Endpoint string `json:"endpoint,omitempty"`
	PID      int    `json:"pid,omitempty"`
}

type Metrics struct {
	TokPerSec   float64 `json:"tokPerSec"`
	ActiveSlots int     `json:"activeSlots"`
	TTFTms      int     `json:"ttftMs"`
	UptimeSec   int64   `json:"uptimeSec"`
}

// Runtime is the local machine's operations the agent exposes to a paired
// desktop. The production impl wires these to blueprint-svc; tests stub it.
type Runtime interface {
	DetectHardware(ctx context.Context) (Hardware, error)
	InstallRuntime(ctx context.Context, emit func(Progress)) error
	PullModel(ctx context.Context, modelID, quant string, emit func(Progress)) error
	Serve(ctx context.Context, spec ServeSpec) (ServeStatus, error)
	Stop(ctx context.Context) error
	Status(ctx context.Context) (ServeStatus, error)
	Metrics(ctx context.Context) (Metrics, error)
}

// Handler adapts a Runtime to the control protocol (agent side).
func Handler(rt Runtime) control.Handler {
	return func(ctx context.Context, method string, params json.RawMessage, emit control.Emit) (any, error) {
		prog := func(p Progress) { _ = emit(p) }
		switch method {
		case MethodDetectHardware:
			return rt.DetectHardware(ctx)
		case MethodInstallRuntime:
			return nil, rt.InstallRuntime(ctx, prog)
		case MethodPullModel:
			var p struct {
				ModelID string `json:"modelId"`
				Quant   string `json:"quant"`
			}
			if err := json.Unmarshal(params, &p); err != nil {
				return nil, err
			}
			return nil, rt.PullModel(ctx, p.ModelID, p.Quant, prog)
		case MethodServe:
			var spec ServeSpec
			if err := json.Unmarshal(params, &spec); err != nil {
				return nil, err
			}
			return rt.Serve(ctx, spec)
		case MethodStop:
			return nil, rt.Stop(ctx)
		case MethodStatus:
			return rt.Status(ctx)
		case MethodMetrics:
			return rt.Metrics(ctx)
		}
		return nil, fmt.Errorf("agent: unknown method %q", method)
	}
}

// Run enrolls with the relay using code, secures the channel, and serves the
// control protocol against rt until ctx is cancelled or the desktop
// disconnects. Handles one enrollment session.
func Run(ctx context.Context, relayURL, code string, rt Runtime) error {
	pairID, secret, err := relay.ParseEnrollCode(code)
	if err != nil {
		return err
	}
	link, err := relay.JoinAsGuest(ctx, relayURL, pairID)
	if err != nil {
		return fmt.Errorf("agent: join relay: %w", err)
	}
	sec, err := relay.SecureAsGuest(link, secret)
	if err != nil {
		return fmt.Errorf("agent: secure channel: %w", err)
	}
	return control.Serve(ctx, sec, Handler(rt))
}
