package agent

// DesktopClient is the desktop side of the enrollment session: a typed driver
// over the control protocol for a paired, E2E-secured agent. This is the
// "agentDriver" the remote deploy flow uses.

import (
	"context"
	"encoding/json"

	"github.com/inspireailab-admin/blueprint-app/internal/control"
	"github.com/inspireailab-admin/blueprint-app/internal/relay"
)

// Enroll starts a desktop enrollment: it registers with the relay and returns
// the user-facing join code (PAIRID-SECRET) to show the user, plus a wait
// function that blocks until the agent pairs, secures the channel, and yields a
// DesktopClient. This is the desktop counterpart of the agent's Run.
func Enroll(ctx context.Context, relayURL string) (code string, wait func() (*DesktopClient, error), err error) {
	pairID, waitHost, err := relay.RegisterAsHost(ctx, relayURL)
	if err != nil {
		return "", nil, err
	}
	code, secret, err := relay.EnrollCode(pairID)
	if err != nil {
		return "", nil, err
	}
	wait = func() (*DesktopClient, error) {
		link, err := waitHost()
		if err != nil {
			return nil, err
		}
		sec, err := relay.SecureAsHost(link, secret)
		if err != nil {
			return nil, err
		}
		return NewDesktopClient(sec), nil
	}
	return code, wait, nil
}

// DesktopClient drives a remote agent over a secured relay link.
type DesktopClient struct {
	c *control.Client
}

// NewDesktopClient wraps a paired, secured link.
func NewDesktopClient(sec *relay.SecureLink) *DesktopClient {
	return &DesktopClient{c: control.NewClient(sec)}
}

// DetectHardware asks the remote machine for its GPUs / CPU / RAM.
func (d *DesktopClient) DetectHardware(ctx context.Context) (Hardware, error) {
	var hw Hardware
	err := d.c.Call(ctx, MethodDetectHardware, nil, &hw)
	return hw, err
}

// InstallRuntime installs llama.cpp on the remote, streaming progress.
func (d *DesktopClient) InstallRuntime(ctx context.Context, onProgress func(Progress)) error {
	return d.c.Stream(ctx, MethodInstallRuntime, nil, progressForwarder(onProgress))
}

// PullModel downloads the GGUF on the remote, streaming progress.
func (d *DesktopClient) PullModel(ctx context.Context, modelID, quant string, onProgress func(Progress)) error {
	params := map[string]string{"modelId": modelID, "quant": quant}
	return d.c.Stream(ctx, MethodPullModel, params, progressForwarder(onProgress))
}

// Serve starts llama-server on the remote with the given spec.
func (d *DesktopClient) Serve(ctx context.Context, spec ServeSpec) (ServeStatus, error) {
	var st ServeStatus
	err := d.c.Call(ctx, MethodServe, spec, &st)
	return st, err
}

// Stop stops the remote server.
func (d *DesktopClient) Stop(ctx context.Context) error {
	return d.c.Call(ctx, MethodStop, nil, nil)
}

// Status returns the remote server state.
func (d *DesktopClient) Status(ctx context.Context) (ServeStatus, error) {
	var st ServeStatus
	err := d.c.Call(ctx, MethodStatus, nil, &st)
	return st, err
}

// Metrics returns live throughput/latency from the remote server.
func (d *DesktopClient) Metrics(ctx context.Context) (Metrics, error) {
	var m Metrics
	err := d.c.Call(ctx, MethodMetrics, nil, &m)
	return m, err
}

func progressForwarder(onProgress func(Progress)) func(json.RawMessage) error {
	return func(raw json.RawMessage) error {
		var p Progress
		if err := json.Unmarshal(raw, &p); err != nil {
			return err
		}
		if onProgress != nil {
			onProgress(p)
		}
		return nil
	}
}
