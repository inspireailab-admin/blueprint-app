// Package svcclient calls a remote blueprint-svc HTTP control plane
// over an SSH tunnel. The desktop GUI uses it to drive a remote host
// the same way it would drive the local svc — same /v1/* endpoints,
// same response shapes.
//
// The trick: net/http's Transport can take a custom DialContext, so
// we tell it to dial via the SSH client. From the GUI side it looks
// like a normal HTTP call to 127.0.0.1; the transport routes it
// through the SSH session.

package svcclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	bpssh "github.com/inspireailab-admin/blueprint-app/internal/ssh"
)

// RemotePort is where the remote blueprint-svc listens. Mirrors
// svcapi.DefaultPort; hard-coded for now because we don't yet have a
// way to discover the actual port at the other end.
const RemotePort = 17832

// TokenPath is where the svc persists its bearer token on the remote.
// Relative to the SSH user's home directory.
const TokenPath = ".blueprint/svc-token"

// Client holds the SSH connection and an HTTP client that tunnels
// through it. One Client per (host, session).
type Client struct {
	ssh   *bpssh.Client
	http  *http.Client
	token string
}

// New opens an SSH connection to the host, fetches the svc token,
// and prepares an HTTP client wired through the SSH tunnel.
func New(ctx context.Context, cfg bpssh.Config) (*Client, error) {
	sc, err := bpssh.Dial(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("ssh dial: %w", err)
	}

	tokenBytes, err := sc.ReadFile(ctx, "~/"+TokenPath)
	if err != nil {
		_ = sc.Close()
		return nil, fmt.Errorf("read svc token (is blueprint-svc installed and started?): %w", err)
	}
	token := strings.TrimSpace(string(tokenBytes))
	if token == "" {
		_ = sc.Close()
		return nil, fmt.Errorf("svc token file is empty")
	}

	transport := &http.Transport{
		DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
			return sc.DialTCP(fmt.Sprintf("127.0.0.1:%d", RemotePort))
		},
		// Pool exactly one connection — we keep it warm and tear it
		// down on Close().
		MaxIdleConns:        1,
		MaxIdleConnsPerHost: 1,
		IdleConnTimeout:     5 * time.Minute,
	}

	return &Client{
		ssh:  sc,
		http: &http.Client{Transport: transport, Timeout: 30 * time.Second},
		token: token,
	}, nil
}

// Close releases the SSH connection and the HTTP transport pool.
func (c *Client) Close() error {
	c.http.CloseIdleConnections()
	return c.ssh.Close()
}

// ─── Endpoints ──────────────────────────────────────────────────────

// Health returns whatever /v1/health emits. Mostly a liveness check.
func (c *Client) Health(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.get(ctx, "/v1/health", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Info returns whatever /v1/info emits (appVersion, host, OS, status).
func (c *Client) Info(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.get(ctx, "/v1/info", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Models returns whatever /v1/models emits ({models: [...]}.).
func (c *Client) Models(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.get(ctx, "/v1/models", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Snapshot returns whatever /v1/snapshot emits.
func (c *Client) Snapshot(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.get(ctx, "/v1/snapshot", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ─── Plumbing ───────────────────────────────────────────────────────

func (c *Client) get(ctx context.Context, path string, into any) error {
	// Host header doesn't matter since the transport ignores it, but
	// net/url requires a parseable URL.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://blueprint-svc"+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("svc HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(into)
}
