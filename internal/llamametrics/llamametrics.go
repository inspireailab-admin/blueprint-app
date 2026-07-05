// Package llamametrics parses and scrapes llama-server's Prometheus /metrics
// endpoint. Lifted from the desktop app's deploy.go so both the desktop and the
// remote agent can read live throughput without duplicating the parser.
package llamametrics

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Metrics is the subset of llama-server metrics we surface.
type Metrics struct {
	PromptTokensTotal     float64
	TokensPredictedTotal  float64
	TokensPerSecond       float64
	PromptTokensPerSecond float64
	RequestsProcessing    float64
	RequestsDeferred      float64
	KvCacheUsageRatio     float64
	KvCacheTokens         float64
}

// Parse walks a Prometheus text body and pulls out the values we care about.
// Lines look like `name 12.34` or `name{label="x"} 12.34`.
func Parse(body []byte) Metrics {
	var m Metrics
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.LastIndex(line, " ")
		if idx < 0 {
			continue
		}
		keyPart := line[:idx]
		val, err := strconv.ParseFloat(strings.TrimSpace(line[idx+1:]), 64)
		if err != nil {
			continue
		}
		if b := strings.Index(keyPart, "{"); b >= 0 {
			keyPart = keyPart[:b]
		}
		switch keyPart {
		case "llamacpp:prompt_tokens_total":
			m.PromptTokensTotal = val
		case "llamacpp:tokens_predicted_total":
			m.TokensPredictedTotal = val
		case "llamacpp:tokens_predicted_seconds", "llamacpp:predicted_tokens_seconds":
			m.TokensPerSecond = val
		case "llamacpp:prompt_tokens_seconds":
			m.PromptTokensPerSecond = val
		case "llamacpp:requests_processing":
			m.RequestsProcessing = val
		case "llamacpp:requests_deferred":
			m.RequestsDeferred = val
		case "llamacpp:kv_cache_usage_ratio":
			m.KvCacheUsageRatio = val
		case "llamacpp:kv_cache_tokens":
			m.KvCacheTokens = val
		}
	}
	return m
}

// Scrape GETs the /metrics endpoint at the given port with a bearer key and
// parses it. ok=false when the server is unreachable or errored.
func Scrape(ctx context.Context, port int, apiKey string) (Metrics, bool) {
	url := fmt.Sprintf("http://127.0.0.1:%d/metrics", port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Metrics{}, false
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return Metrics{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Metrics{}, false
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Metrics{}, false
	}
	return Parse(body), true
}
