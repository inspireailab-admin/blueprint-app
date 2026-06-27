// Package svcclient calls a remote blueprint-svc HTTP control plane
// over an SSH tunnel. The desktop GUI uses it to drive a remote host
// the same way it would drive the local svc — same /v1/* endpoints,
// same response shapes.
//
// The trick: net/http's Transport can take a custom DialContext, so
// we tell it to dial via the SSH client. From the GUI side it looks
// like a normal HTTP call to 127.0.0.1; the transport routes it
// through the SSH session.
//
// Author: Amar Mond.
package svcclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
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

// TokenCache is the optional cross-session cache svcclient.New
// consults before paying the SSH-fetch cost for the svc bearer token.
// Each instance is pre-bound to a specific host by its caller — the
// svcclient package itself stays ignorant of host identity.
//
// A nil TokenCache disables caching entirely (svcclient falls back to
// fetching the token over SSH on every New).
type TokenCache interface {
	Get() (string, bool)
	Set(token string) error
}

// Client holds the SSH connection and an HTTP client that tunnels
// through it. One Client per (host, session).
type Client struct {
	ssh   *bpssh.Client
	http  *http.Client
	token string
}

// New opens an SSH connection to the host and prepares an HTTP client
// wired through the SSH tunnel. The svc bearer token comes from the
// optional cache; on miss or 401 we fall back to reading
// ~/.blueprint/svc-token over SSH and update the cache for next time.
func New(ctx context.Context, cfg bpssh.Config, cache TokenCache) (*Client, error) {
	sc, err := bpssh.Dial(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("ssh dial: %w", err)
	}

	var (
		token     string
		fromCache bool
		freshFromSSH bool
	)
	if cache != nil {
		if cached, ok := cache.Get(); ok && cached != "" {
			token = cached
			fromCache = true
		}
	}
	if token == "" {
		token, err = fetchTokenOverSSH(ctx, sc)
		if err != nil {
			_ = sc.Close()
			return nil, err
		}
		freshFromSSH = true
	}

	c := buildClient(sc, token)

	// Verify only when the token came from cache — a freshly-fetched
	// token is by definition the current one, and skipping the extra
	// round-trip keeps cold-connect latency unchanged.
	if fromCache {
		if err := c.pingHealth(ctx); err != nil {
			if !isAuthErr(err) {
				_ = sc.Close()
				return nil, err
			}
			// Cached token rejected — refetch, rebuild, retry once.
			token, err = fetchTokenOverSSH(ctx, sc)
			if err != nil {
				_ = sc.Close()
				return nil, err
			}
			freshFromSSH = true
			c = buildClient(sc, token)
			if err := c.pingHealth(ctx); err != nil {
				_ = sc.Close()
				return nil, fmt.Errorf("svc health after token refetch: %w", err)
			}
		}
	}

	// Persist any fresh token to the cache so the next connect skips
	// the SSH-fetch. Best-effort: an unavailable keychain shouldn't
	// fail the connection itself.
	if cache != nil && freshFromSSH {
		_ = cache.Set(token)
	}

	return c, nil
}

func fetchTokenOverSSH(ctx context.Context, sc *bpssh.Client) (string, error) {
	b, err := sc.ReadFile(ctx, "~/"+TokenPath)
	if err != nil {
		return "", fmt.Errorf("read svc token (is blueprint-svc installed and started?): %w", err)
	}
	token := strings.TrimSpace(string(b))
	if token == "" {
		return "", fmt.Errorf("svc token file is empty")
	}
	return token, nil
}

func buildClient(sc *bpssh.Client, token string) *Client {
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
		ssh:   sc,
		http:  &http.Client{Transport: transport, Timeout: 30 * time.Second},
		token: token,
	}
}

func (c *Client) pingHealth(ctx context.Context) error {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := c.Health(probeCtx)
	return err
}

// isAuthErr matches the "svc HTTP 401: ..." shape do() emits so the
// cache-refetch path can distinguish a bad token from svc-is-down.
func isAuthErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "svc HTTP 401")
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

// Serve POSTs a svcconfig.Config payload (or a partial patch) to
// /v1/serve. The remote supervisor picks up the new config within
// ~5 seconds and respawns llama-server against it.
func (c *Client) Serve(ctx context.Context, payload map[string]any) (map[string]any, error) {
	var out map[string]any
	if err := c.post(ctx, "/v1/serve", payload, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Stop POSTs to /v1/stop. The remote supervisor deletes the config
// and stops the child within ~5 seconds.
func (c *Client) Stop(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.post(ctx, "/v1/stop", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Pull starts (or attaches to an existing) background download of a
// model + quant directly onto the remote host. Idempotent — calling
// twice for the same pair while a download is in flight returns the
// in-flight state instead of spawning a second downloader. The GUI
// then polls PullStatus on a short interval to drive a progress UI.
func (c *Client) Pull(ctx context.Context, modelID, quant string) (map[string]any, error) {
	payload := map[string]any{"modelId": modelID, "quant": quant}
	var out map[string]any
	if err := c.post(ctx, "/v1/pull", payload, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PullStatus returns the current PullState for a (modelID, quant)
// pair. Errors when the svc has no record of a pull for that pair.
func (c *Client) PullStatus(ctx context.Context, modelID, quant string) (map[string]any, error) {
	path := fmt.Sprintf("/v1/pull?modelId=%s&quant=%s",
		url.QueryEscape(modelID), url.QueryEscape(quant))
	var out map[string]any
	if err := c.get(ctx, path, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ChatMessage is one entry in the conversation. Maps 1:1 to the
// OpenAI chat-completion role/content schema.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatCompletion sends a non-streaming chat request to the supervised
// llama-server via the svc's /llama proxy. Returns the assistant's
// reply text + the raw response for callers that want token counts.
func (c *Client) ChatCompletion(
	ctx context.Context,
	model string,
	messages []ChatMessage,
	maxTokens int,
	temperature float64,
) (string, map[string]any, error) {
	if model == "" {
		model = "local"
	}
	payload := map[string]any{
		"model":       model,
		"messages":    messages,
		"max_tokens":  maxTokens,
		"temperature": temperature,
		"stream":      false,
	}
	var raw map[string]any
	if err := c.post(ctx, "/llama/v1/chat/completions", payload, &raw); err != nil {
		return "", nil, err
	}
	// OpenAI shape: { choices: [ { message: { content: "..." } } ] }
	choices, _ := raw["choices"].([]any)
	if len(choices) == 0 {
		return "", raw, fmt.Errorf("no choices in response")
	}
	c0, _ := choices[0].(map[string]any)
	msg, _ := c0["message"].(map[string]any)
	content, _ := msg["content"].(string)
	return content, raw, nil
}

// ChatCompletionStream is the streaming sibling of ChatCompletion.
// Invokes onDelta for every token-delta the server emits. Returns
// the accumulated content on completion. The proxy chain (GUI -> SSH
// tunnel -> svc /llama -> llama-server) propagates SSE just fine —
// httputil.ReverseProxy with FlushInterval=100ms keeps chunks flowing.
//
// onDelta is called from the same goroutine as the caller; it doesn't
// need to be thread-safe but should be cheap.
func (c *Client) ChatCompletionStream(
	ctx context.Context,
	model string,
	messages []ChatMessage,
	maxTokens int,
	temperature float64,
	extra map[string]any,
	onDelta func(delta string),
) (string, error) {
	if model == "" {
		model = "local"
	}
	payload := map[string]any{
		"model":       model,
		"messages":    messages,
		"max_tokens":  maxTokens,
		"temperature": temperature,
		"stream":      true,
	}
	for k, v := range extra {
		payload[k] = v
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"http://blueprint-svc/llama/v1/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	// Use a streaming-friendly client — the default 30s Timeout would
	// kill a long generation mid-stream.
	streamingClient := &http.Client{Transport: c.http.Transport}
	resp, err := streamingClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("svc HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var content strings.Builder
	scanner := bufio.NewScanner(resp.Body)
	// SSE chunks can be larger than the default 64 KB buffer.
	scanner.Buffer(make([]byte, 0, 4096), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		for _, ch := range chunk.Choices {
			if ch.Delta.Content != "" {
				content.WriteString(ch.Delta.Content)
				onDelta(ch.Delta.Content)
			}
		}
	}
	if err := scanner.Err(); err != nil && err != ctx.Err() {
		return content.String(), err
	}
	return content.String(), nil
}

// ─── Plumbing ───────────────────────────────────────────────────────

func (c *Client) get(ctx context.Context, path string, into any) error {
	return c.do(ctx, http.MethodGet, path, nil, into)
}

func (c *Client) post(ctx context.Context, path string, body any, into any) error {
	return c.do(ctx, http.MethodPost, path, body, into)
}

func (c *Client) do(ctx context.Context, method, path string, body any, into any) error {
	var bodyReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(raw)
	}
	// Host header doesn't matter since the transport ignores it, but
	// net/url requires a parseable URL.
	req, err := http.NewRequestWithContext(ctx, method,
		"http://blueprint-svc"+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("svc HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if into == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(into)
}
