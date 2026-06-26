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

	"github.com/wailsapp/wails/v2/pkg/runtime"

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

// RemoteHostServe POSTs to the host's /v1/serve. payload is a
// (partial) svcconfig.Config — modelPath is required, the supervisor
// merges other fields with the previous config on the remote side.
func (a *App) RemoteHostServe(id string, payload map[string]any) (map[string]any, error) {
	c, ok := getHostClient(id)
	if !ok {
		return nil, fmt.Errorf("not connected — call ConnectHost first")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return c.Serve(ctx, payload)
}

// RemoteHostStop POSTs to the host's /v1/stop. The remote supervisor
// removes the config and stops the running child within ~5s.
func (a *App) RemoteHostStop(id string) (map[string]any, error) {
	c, ok := getHostClient(id)
	if !ok {
		return nil, fmt.Errorf("not connected — call ConnectHost first")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return c.Stop(ctx)
}

// RemoteChatRequest is the GUI's chat payload.
type RemoteChatRequest struct {
	Model       string                  `json:"model"`
	Messages    []svcclient.ChatMessage `json:"messages"`
	MaxTokens   int                     `json:"maxTokens"`
	Temperature float64                 `json:"temperature"`
	// Extra carries advanced sampling params (top_k, top_p, min_p,
	// repeat_penalty, presence_penalty, frequency_penalty, seed,
	// stop, system) that get merged into the OpenAI payload as-is.
	// Names follow llama-server's snake_case convention so the GUI
	// doesn't have to translate.
	Extra map[string]any `json:"extra,omitempty"`
}

// RemoteChatResult is what the GUI renders.
type RemoteChatResult struct {
	OK      bool           `json:"ok"`
	Content string         `json:"content,omitempty"`
	Raw     map[string]any `json:"raw,omitempty"`
	Error   string         `json:"error,omitempty"`
}

// RemoteChat issues a chat-completion request against the supervised
// llama-server on the connected host. Non-streaming for v1.
func (a *App) RemoteChat(id string, req RemoteChatRequest) RemoteChatResult {
	c, ok := getHostClient(id)
	if !ok {
		return RemoteChatResult{Error: "not connected — call ConnectHost first"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	content, raw, err := c.ChatCompletion(ctx, req.Model, req.Messages, req.MaxTokens, req.Temperature)
	if err != nil {
		return RemoteChatResult{Error: err.Error()}
	}
	return RemoteChatResult{OK: true, Content: content, Raw: raw}
}

// RemoteChatStreamEvent is the Wails event channel for streamed chat
// chunks. Each event carries the host id, a stream tag ('delta' or
// 'done' or 'error'), and either the delta text or the final
// accumulated content.
const RemoteChatStreamEvent = "host:chat:chunk"

// RemoteChatStream is the streaming sibling of RemoteChat. Emits
// host:chat:chunk events with {id, stream: 'delta'|'done'|'error',
// text: <delta or final or error>} as the response comes in. Returns
// the final accumulated content + ok flag once the SSE stream
// completes (or an error result on dial / HTTP failure).
//
// The frontend listens on host:chat:chunk and appends each delta
// to the currently in-flight assistant message.
func (a *App) RemoteChatStream(id string, req RemoteChatRequest) RemoteChatResult {
	c, ok := getHostClient(id)
	if !ok {
		return RemoteChatResult{Error: "not connected — call ConnectHost first"}
	}

	emit := func(stream, text string) {
		runtime.EventsEmit(a.ctx, RemoteChatStreamEvent, map[string]any{
			"id":     id,
			"stream": stream,
			"text":   text,
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	extra := map[string]any{}
	for k, v := range req.Extra {
		extra[k] = v
	}

	content, err := c.ChatCompletionStream(
		ctx,
		req.Model,
		req.Messages,
		req.MaxTokens,
		req.Temperature,
		extra,
		func(delta string) { emit("delta", delta) },
	)
	if err != nil {
		emit("error", err.Error())
		return RemoteChatResult{Error: err.Error(), Content: content}
	}
	emit("done", content)
	return RemoteChatResult{OK: true, Content: content}
}
