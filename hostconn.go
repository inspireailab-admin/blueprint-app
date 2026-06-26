// Hosts connection IPC — Connect/Disconnect a remote host's svc and
// drive its /v1/* endpoints from the desktop GUI.
//
// One Client per (host, session). The pool is keyed by host ID and
// reused across calls to RemoteHostInfo / RemoteHostModels / etc.
// Connect is explicit; we never auto-dial because SSH connections
// hold a TCP socket and a remote shell session — the user should
// know they're paying for that.

package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	bpssh "github.com/inspireailab-admin/blueprint-app/internal/ssh"
	"github.com/inspireailab-admin/blueprint-app/internal/svcclient"
)

var (
	hostConnMu sync.Mutex
	hostConns  = map[string]*svcclient.Client{}
)

func getHostClient(id string) (*svcclient.Client, bool) {
	hostConnMu.Lock()
	defer hostConnMu.Unlock()
	c, ok := hostConns[id]
	return c, ok
}

func setHostClient(id string, c *svcclient.Client) {
	hostConnMu.Lock()
	defer hostConnMu.Unlock()
	if old, ok := hostConns[id]; ok && old != nil {
		_ = old.Close()
	}
	hostConns[id] = c
}

func clearHostClient(id string) {
	hostConnMu.Lock()
	defer hostConnMu.Unlock()
	if c, ok := hostConns[id]; ok && c != nil {
		_ = c.Close()
		delete(hostConns, id)
	}
}

// HostConnectResult is the verdict the UI renders after a Connect attempt.
type HostConnectResult struct {
	ID        string         `json:"id"`
	Connected bool           `json:"connected"`
	Health    map[string]any `json:"health,omitempty"`
	Error     string         `json:"error,omitempty"`
}

// ConnectHost opens an SSH connection to the host, fetches the svc
// bearer token, and hits /v1/health to confirm the control plane is
// alive. The connection is cached so subsequent RemoteHost* calls
// re-use it.
func (a *App) ConnectHost(id string) HostConnectResult {
	out := HostConnectResult{ID: id}

	h, ok := getHosts().Get(id)
	if !ok {
		out.Error = "host not found in registry"
		return out
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	client, err := svcclient.New(ctx, bpssh.Config{
		User:    h.User,
		Host:    h.Host,
		Port:    h.Port,
		KeyPath: h.KeyPath,
	})
	if err != nil {
		out.Error = err.Error()
		return out
	}

	health, err := client.Health(ctx)
	if err != nil {
		_ = client.Close()
		out.Error = "control plane unreachable: " + err.Error()
		return out
	}

	setHostClient(id, client)
	getHosts().TouchSeen(id)
	out.Connected = true
	out.Health = health
	return out
}

// DisconnectHost closes the cached SSH connection. Idempotent.
func (a *App) DisconnectHost(id string) {
	clearHostClient(id)
}

// IsHostConnected reports whether the GUI currently holds a live
// connection to the host.
func (a *App) IsHostConnected(id string) bool {
	_, ok := getHostClient(id)
	return ok
}

// RemoteHostInfo proxies /v1/info on the connected host. Errors if
// the host isn't connected.
func (a *App) RemoteHostInfo(id string) (map[string]any, error) {
	c, ok := getHostClient(id)
	if !ok {
		return nil, fmt.Errorf("not connected — call ConnectHost first")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.Info(ctx)
}

// RemoteHostModels proxies /v1/models on the connected host.
func (a *App) RemoteHostModels(id string) (map[string]any, error) {
	c, ok := getHostClient(id)
	if !ok {
		return nil, fmt.Errorf("not connected — call ConnectHost first")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.Models(ctx)
}

// RemoteHostSnapshot proxies /v1/snapshot on the connected host.
func (a *App) RemoteHostSnapshot(id string) (map[string]any, error) {
	c, ok := getHostClient(id)
	if !ok {
		return nil, fmt.Errorf("not connected — call ConnectHost first")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.Snapshot(ctx)
}
