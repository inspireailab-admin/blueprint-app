// Enrollment IPC — the desktop side of adding a remote machine via the relay
// (docs/plan-target-aware-deploy.md §4/§5). StartEnrollment returns a join code
// to show the user; when their machine runs the installer with that code and
// pairs, it joins the fleet and we hold an E2E-encrypted control connection to
// drive deploys and read metrics.
//
// Events emitted:
//   fleet:enrolled      fleet.Machine   — a machine finished pairing
//   fleet:enroll-error  {error}         — pairing failed
//   fleet:progress      {machineId, op, stage, pct, detail} — install/pull steps
//
// Author: Amar Mond.
package main

import (
	"fmt"
	"sync"

	"github.com/inspireailab-admin/blueprint-app/internal/agent"
	"github.com/inspireailab-admin/blueprint-app/internal/fleet"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// relayEnrollURL is Blueprint's always-on enrollment relay.
const relayEnrollURL = "wss://relay.llmblueprint.ai/enroll"

var (
	fleetOnce sync.Once
	fleetReg  *fleet.Registry

	fleetConnsMu sync.Mutex
	fleetConns   = map[string]*agent.DesktopClient{} // machine id → live connection
)

func getFleet() *fleet.Registry {
	fleetOnce.Do(func() { fleetReg = fleet.New() })
	return fleetReg
}

func setFleetConn(id string, dc *agent.DesktopClient) {
	fleetConnsMu.Lock()
	fleetConns[id] = dc
	fleetConnsMu.Unlock()
}

func getFleetConn(id string) (*agent.DesktopClient, bool) {
	fleetConnsMu.Lock()
	defer fleetConnsMu.Unlock()
	dc, ok := fleetConns[id]
	return dc, ok
}

func clearFleetConn(id string) {
	fleetConnsMu.Lock()
	if dc, ok := fleetConns[id]; ok {
		_ = dc.Close()
		delete(fleetConns, id)
	}
	fleetConnsMu.Unlock()
}

// EnrollResult carries the join code back to the UI.
type EnrollResult struct {
	Code string `json:"code"` // PAIRID-SECRET — show this to the user
}

// StartEnrollment begins enrolling a remote machine and returns the join code
// to display. Pairing happens asynchronously: on success a "fleet:enrolled"
// event fires with the new machine; on failure, "fleet:enroll-error".
func (a *App) StartEnrollment(label string) (EnrollResult, error) {
	code, wait, err := agent.Enroll(a.ctx, relayEnrollURL)
	if err != nil {
		return EnrollResult{}, err
	}
	go func() {
		dc, err := wait() // blocks until the agent pairs + the channel is secured
		if err != nil {
			wailsruntime.EventsEmit(a.ctx, "fleet:enroll-error", map[string]string{"error": err.Error()})
			return
		}
		hw, err := dc.DetectHardware(a.ctx)
		if err != nil {
			_ = dc.Close()
			wailsruntime.EventsEmit(a.ctx, "fleet:enroll-error", map[string]string{
				"error": "paired, but hardware probe failed: " + err.Error(),
			})
			return
		}
		m, _ := getFleet().Add(fleet.Machine{Label: label, Hardware: hw})
		setFleetConn(m.ID, dc)
		wailsruntime.EventsEmit(a.ctx, "fleet:enrolled", m)
	}()
	return EnrollResult{Code: code}, nil
}

// ListEnrolledMachines returns the persisted fleet.
func (a *App) ListEnrolledMachines() []fleet.Machine {
	return getFleet().List()
}

// IsMachineConnected reports whether we currently hold a live control
// connection to a machine (false = offline; reconnection is a follow-up).
func (a *App) IsMachineConnected(id string) bool {
	_, ok := getFleetConn(id)
	return ok
}

// RemoveEnrolledMachine drops a machine and closes any live connection.
func (a *App) RemoveEnrolledMachine(id string) error {
	clearFleetConn(id)
	return getFleet().Remove(id)
}

// ─── Remote deploy driver (mirrors deploy.go, over the relay) ───────────────

func (a *App) remoteConn(id string) (*agent.DesktopClient, error) {
	dc, ok := getFleetConn(id)
	if !ok {
		return nil, fmt.Errorf("machine %q is not connected — it may be offline (reconnect not yet supported)", id)
	}
	return dc, nil
}

// RemoteDetectHardware refreshes and returns a machine's hardware.
func (a *App) RemoteDetectHardware(id string) (agent.Hardware, error) {
	dc, err := a.remoteConn(id)
	if err != nil {
		return agent.Hardware{}, err
	}
	hw, err := dc.DetectHardware(a.ctx)
	if err == nil {
		getFleet().UpdateHardware(id, hw)
	}
	return hw, err
}

// RemoteInstallRuntime installs llama.cpp on a machine, streaming progress.
func (a *App) RemoteInstallRuntime(id string) error {
	dc, err := a.remoteConn(id)
	if err != nil {
		return err
	}
	return dc.InstallRuntime(a.ctx, func(p agent.Progress) {
		wailsruntime.EventsEmit(a.ctx, "fleet:progress", fleetProgress(id, "install-runtime", p))
	})
}

// RemotePullModel pulls a model's GGUF on a machine, streaming progress.
func (a *App) RemotePullModel(id, modelID, quant string) error {
	dc, err := a.remoteConn(id)
	if err != nil {
		return err
	}
	return dc.PullModel(a.ctx, modelID, quant, func(p agent.Progress) {
		wailsruntime.EventsEmit(a.ctx, "fleet:progress", fleetProgress(id, "pull-model", p))
	})
}

// RemoteServe starts llama-server on a machine.
func (a *App) RemoteServe(id string, spec agent.ServeSpec) (agent.ServeStatus, error) {
	dc, err := a.remoteConn(id)
	if err != nil {
		return agent.ServeStatus{}, err
	}
	return dc.Serve(a.ctx, spec)
}

// RemoteStop stops a machine's server.
func (a *App) RemoteStop(id string) error {
	dc, err := a.remoteConn(id)
	if err != nil {
		return err
	}
	return dc.Stop(a.ctx)
}

// RemoteStatus returns a machine's server state.
func (a *App) RemoteStatus(id string) (agent.ServeStatus, error) {
	dc, err := a.remoteConn(id)
	if err != nil {
		return agent.ServeStatus{}, err
	}
	return dc.Status(a.ctx)
}

// RemoteMetrics returns a machine's live throughput/latency.
func (a *App) RemoteMetrics(id string) (agent.Metrics, error) {
	dc, err := a.remoteConn(id)
	if err != nil {
		return agent.Metrics{}, err
	}
	return dc.Metrics(a.ctx)
}

func fleetProgress(id, op string, p agent.Progress) map[string]any {
	return map[string]any{
		"machineId": id, "op": op,
		"stage": p.Stage, "pct": p.Pct, "detail": p.Detail,
	}
}
