// Remote-server IPC — list / add / update / remove + probe.
//
// Probe = a one-shot HTTP GET against the remote's /health (or
// equivalent) with a 3-second timeout. The Dashboard polls this
// every few seconds so each remote card paints a live status dot.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/remotes"
)

var (
	remotesOnce sync.Once
	remotesReg  *remotes.Registry
)

func getRemotes() *remotes.Registry {
	remotesOnce.Do(func() {
		remotesReg = remotes.New()
	})
	return remotesReg
}

// ListRemoteServers returns every registered remote.
func (a *App) ListRemoteServers() []remotes.Remote {
	return getRemotes().List()
}

// AddRemoteServer registers a new one.
func (a *App) AddRemoteServer(in remotes.Remote) (remotes.Remote, error) {
	return getRemotes().Add(in)
}

// UpdateRemoteServer edits an existing entry by ID.
func (a *App) UpdateRemoteServer(in remotes.Remote) error {
	return getRemotes().Update(in)
}

// RemoveRemoteServer drops an entry.
func (a *App) RemoveRemoteServer(id string) error {
	return getRemotes().Remove(id)
}

// RemoteProbeResult is the per-remote status the Dashboard renders.
type RemoteProbeResult struct {
	ID         string `json:"id"`
	Reachable  bool   `json:"reachable"`
	LatencyMs  int64  `json:"latencyMs"`
	StatusCode int    `json:"statusCode"`
	Models     []string `json:"models,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ProbeRemoteServer runs a one-shot probe and returns the verdict.
// Tries /v1/models (the universal OpenAI-compatible health proxy)
// rather than /health since /health isn't part of the OpenAI API
// spec and not every vendor exposes it.
func (a *App) ProbeRemoteServer(id string) RemoteProbeResult {
	out := RemoteProbeResult{ID: id}
	r, ok := getRemotes().Get(id)
	if !ok {
		out.Error = "remote not found"
		return out
	}

	baseURL := strings.TrimRight(r.BaseURL, "/")
	url := baseURL + "/models"

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	if r.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+r.APIKey)
	}
	t0 := time.Now()
	resp, err := http.DefaultClient.Do(req)
	out.LatencyMs = time.Since(t0).Milliseconds()
	if err != nil {
		out.Error = err.Error()
		return out
	}
	defer resp.Body.Close()
	out.StatusCode = resp.StatusCode

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		out.Reachable = true
		var body struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if json.NewDecoder(resp.Body).Decode(&body) == nil {
			for _, m := range body.Data {
				out.Models = append(out.Models, m.ID)
			}
		}
		return out
	}
	out.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
	return out
}

// ProbeAllRemoteServers runs probes for every registered remote in
// parallel. Used by the Dashboard to render the whole list at once.
func (a *App) ProbeAllRemoteServers() []RemoteProbeResult {
	list := getRemotes().List()
	out := make([]RemoteProbeResult, len(list))
	var wg sync.WaitGroup
	for i, r := range list {
		i, r := i, r
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i] = a.ProbeRemoteServer(r.ID)
		}()
	}
	wg.Wait()
	return out
}
