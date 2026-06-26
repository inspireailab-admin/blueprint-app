// Package svcapi is the blueprint-svc HTTP control plane.
//
// It binds to 127.0.0.1 only — the API is reached from a remote
// desktop GUI by tunnelling over SSH (Phase B.4). Never exposes
// itself on the public network; that's an SSH operator's choice to
// make, not ours.
//
// Auth is a bearer token written to ~/.blueprint/svc-token at first
// launch with 0600 perms. Anyone with file-system access to the
// directory can read the token — same trust model as docker.sock
// or kubeconfig. The token is what the desktop GUI captures from
// the install-script output (Phase B.4).
//
// Endpoints are versioned under /v1/ so we can evolve without
// breaking older desktop builds in the wild:
//
//   GET  /v1/health     liveness — returns {ok: true, version}
//   GET  /v1/info       svc state — version, phase, model, port
//   GET  /v1/models     installed models (catalog id + quant + size)
//   GET  /v1/snapshot   system snapshot — host + os + cpu + mem
//
// Phase B.3 ships read-only. Write endpoints (start/stop/serve)
// come in B.3b once the read path is shaken out.

package svcapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"

	"github.com/inspireailab-admin/blueprint-cli/pkg/catalog"
	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

const (
	// DefaultPort is what blueprint-svc listens on for the control
	// plane unless overridden via SVCAPI_PORT or svcconfig. Picked to
	// be unlikely to collide with anything else on a developer's box
	// (and well above the ephemeral range so it doesn't get stolen).
	DefaultPort = 17832

	// TokenFile is the path inside ~/.blueprint/ where the bearer
	// token is persisted at 0600.
	TokenFile = "svc-token"
)

// Version of the API contract. Bumped on breaking changes.
const APIVersion = "v1"

// Server is the HTTP control plane.
type Server struct {
	appVersion string
	token      string
	mux        *http.ServeMux
}

// New constructs a Server. Reads (or generates) the bearer token from
// disk. appVersion is the build-time string the svc was compiled with.
func New(appVersion string) (*Server, error) {
	token, err := loadOrCreateToken()
	if err != nil {
		return nil, err
	}
	s := &Server{appVersion: appVersion, token: token}
	s.mux = s.routes()
	return s, nil
}

// Token returns the bearer token. blueprint-svc prints this at
// install time so the desktop GUI can capture it for the host
// registry.
func (s *Server) Token() string { return s.token }

// Handler is the http.Handler the supervisor mounts.
func (s *Server) Handler() http.Handler { return s.mux }

// ListenAndServe binds to 127.0.0.1:port and serves until the server
// is shut down externally. Blocking — call from a goroutine.
func (s *Server) ListenAndServe(port int) error {
	if port == 0 {
		port = DefaultPort
	}
	srv := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", port),
		Handler:           s.mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	return srv.ListenAndServe()
}

// ─── Routes ────────────────────────────────────────────────────────

func (s *Server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", s.auth(s.handleHealth))
	mux.HandleFunc("/v1/info", s.auth(s.handleInfo))
	mux.HandleFunc("/v1/models", s.auth(s.handleModels))
	mux.HandleFunc("/v1/snapshot", s.auth(s.handleSnapshot))
	mux.HandleFunc("/v1/serve", s.auth(s.handleServe))
	mux.HandleFunc("/v1/stop", s.auth(s.handleStop))
	// /llama/* reverse-proxies to the supervised llama-server on
	// 127.0.0.1:{cfg.Port}. The svc strips the /llama prefix and
	// injects llama-server's APIKey as the bearer header — the
	// GUI only sees the svc token, never the llama key.
	mux.HandleFunc("/llama/", s.auth(s.handleLlamaProxy))
	return mux
}

// auth wraps a handler with constant-time bearer check.
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(header, prefix) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
			return
		}
		got := header[len(prefix):]
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid token"})
			return
		}
		next(w, r)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"version":    s.appVersion,
		"apiVersion": APIVersion,
		"timestamp":  time.Now().Unix(),
	})
}

type infoResponse struct {
	AppVersion string           `json:"appVersion"`
	APIVersion string           `json:"apiVersion"`
	Status     svcconfig.Status `json:"status"`
	Host       string           `json:"host"`
	OS         string           `json:"os"`
	Arch       string           `json:"arch"`
}

func (s *Server) handleInfo(w http.ResponseWriter, _ *http.Request) {
	host, _ := os.Hostname()
	st, _ := svcconfig.ReadStatus()
	status := svcconfig.Status{Phase: "unknown"}
	if st != nil {
		status = *st
	}
	writeJSON(w, http.StatusOK, infoResponse{
		AppVersion: s.appVersion,
		APIVersion: APIVersion,
		Status:     status,
		Host:       host,
		OS:         runtime.GOOS,
		Arch:       runtime.GOARCH,
	})
}

type modelEntry struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Quant       string `json:"quant"`
	FileName    string `json:"fileName"`
	BytesSize   int64  `json:"bytesSize"`
}

func (s *Server) handleModels(w http.ResponseWriter, _ *http.Request) {
	root, err := paths.Root()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	modelsDir := filepath.Join(root, "models")
	entries, err := os.ReadDir(modelsDir)
	if err != nil && !os.IsNotExist(err) {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	cat, _ := catalog.LoadFull()
	byID := map[string]catalog.Model{}
	for _, m := range cat.Models {
		byID[m.ID] = m
	}

	out := make([]modelEntry, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".gguf") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		id, quant := parseModelFile(e.Name())
		display := id
		if m, ok := byID[id]; ok {
			display = m.DisplayName
		}
		out = append(out, modelEntry{
			ID:          id,
			DisplayName: display,
			Quant:       quant,
			FileName:    e.Name(),
			BytesSize:   info.Size(),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": out})
}

type gpuEntry struct {
	Index       int     `json:"index"`
	Name        string  `json:"name"`
	UtilPct     float64 `json:"utilPct"`
	VramUsedMB  int64   `json:"vramUsedMB"`
	VramTotalMB int64   `json:"vramTotalMB"`
}

type snapshotResponse struct {
	Host          string     `json:"host"`
	OS            string     `json:"os"`
	Arch          string     `json:"arch"`
	NumCPU        int        `json:"numCPU"`
	GoVersion     string     `json:"goVersion"`
	UptimeSeconds float64    `json:"uptimeSeconds"`
	CPUUtilPct    float64    `json:"cpuUtilPct"`
	RAMUsedPct    float64    `json:"ramUsedPct"`
	RAMUsedMB     int64      `json:"ramUsedMB"`
	RAMTotalMB    int64      `json:"ramTotalMB"`
	GPUs          []gpuEntry `json:"gpus"`
}

var svcStartedAt = time.Now()

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	host, _ := os.Hostname()

	out := snapshotResponse{
		Host:          host,
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		NumCPU:        runtime.NumCPU(),
		GoVersion:     runtime.Version(),
		UptimeSeconds: time.Since(svcStartedAt).Seconds(),
		GPUs:          []gpuEntry{},
	}

	// CPU: 0 duration → instantaneous (cumulative delta the lib has
	// cached). First call returns 0 but subsequent calls (the GUI
	// polls every 3s) return real numbers.
	if pcts, err := cpu.PercentWithContext(r.Context(), 0, false); err == nil && len(pcts) > 0 {
		out.CPUUtilPct = pcts[0]
	}
	if v, err := mem.VirtualMemoryWithContext(r.Context()); err == nil && v != nil {
		out.RAMUsedPct = v.UsedPercent
		out.RAMUsedMB = int64(v.Used / 1024 / 1024)
		out.RAMTotalMB = int64(v.Total / 1024 / 1024)
	}

	out.GPUs = readNvidiaSmi(r.Context())

	writeJSON(w, http.StatusOK, out)
}

// readNvidiaSmi shells out to nvidia-smi for the per-GPU snapshot.
// Returns empty slice if nvidia-smi isn't installed or fails — the GUI
// renders a "no GPUs detected" empty state.
//
// AMD ROCm + Apple Silicon paths land in a follow-up; for v1 nvidia
// covers ~95% of the calibration / serving workload.
func readNvidiaSmi(ctx context.Context) []gpuEntry {
	out := []gpuEntry{}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nvidia-smi",
		"--query-gpu=index,name,utilization.gpu,memory.used,memory.total",
		"--format=csv,noheader,nounits")
	raw, err := cmd.Output()
	if err != nil {
		return out
	}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		fields := strings.Split(line, ",")
		if len(fields) < 5 {
			continue
		}
		var g gpuEntry
		fmt.Sscanf(strings.TrimSpace(fields[0]), "%d", &g.Index)
		g.Name = strings.TrimSpace(fields[1])
		fmt.Sscanf(strings.TrimSpace(fields[2]), "%f", &g.UtilPct)
		fmt.Sscanf(strings.TrimSpace(fields[3]), "%d", &g.VramUsedMB)
		fmt.Sscanf(strings.TrimSpace(fields[4]), "%d", &g.VramTotalMB)
		out = append(out, g)
	}
	return out
}

// handleServe accepts a partial svcconfig.Config payload and writes
// it to the config file. The supervisor goroutine notices the new
// UpdatedAt timestamp within ~5 seconds and respawns llama-server
// against the new config.
//
// Optional fields not set in the request inherit from the previous
// config — convenient for "swap the model without re-sending every
// flag" calls from the GUI.
func (s *Server) handleServe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	var in svcconfig.Config
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	if in.ModelPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "modelPath is required"})
		return
	}

	// Merge with current config so callers can send a partial patch.
	if prev, err := svcconfig.ReadConfig(); err == nil && prev != nil {
		if in.LlamaServerBin == "" {
			in.LlamaServerBin = prev.LlamaServerBin
		}
		if in.BindHost == "" {
			in.BindHost = prev.BindHost
		}
		if in.Port == 0 {
			in.Port = prev.Port
		}
		if in.APIKey == "" {
			in.APIKey = prev.APIKey
		}
	}
	if in.BindHost == "" {
		in.BindHost = "127.0.0.1"
	}
	if in.Port == 0 {
		in.Port = 8080
	}
	in.UpdatedAt = time.Now().UnixMilli()
	if err := svcconfig.WriteConfig(in); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "write config: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accepted":  true,
		"updatedAt": in.UpdatedAt,
		"note":      "supervisor picks up the new config within ~5s",
	})
}

// handleLlamaProxy reverse-proxies /llama/* to the supervised
// llama-server. The svc reads the current svcconfig on every
// request (cheap — it's a small JSON file) so the proxy follows
// the running model even after a hot-swap via /v1/serve. Strips
// the "/llama" prefix and injects the llama APIKey so the GUI
// never has to know it.
func (s *Server) handleLlamaProxy(w http.ResponseWriter, r *http.Request) {
	cfg, err := svcconfig.ReadConfig()
	if err != nil || cfg == nil || cfg.Port == 0 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "no llama-server config — start a model via /v1/serve first",
		})
		return
	}
	bind := cfg.BindHost
	if bind == "" || bind == "0.0.0.0" {
		bind = "127.0.0.1"
	}
	target, err := url.Parse(fmt.Sprintf("http://%s:%d", bind, cfg.Port))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Strip the "/llama" prefix from the inbound path so it lines up
	// with llama-server's native API surface.
	r.URL.Path = strings.TrimPrefix(r.URL.Path, "/llama")
	if !strings.HasPrefix(r.URL.Path, "/") {
		r.URL.Path = "/" + r.URL.Path
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Director = func(req *http.Request) {
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.Host = target.Host
		if cfg.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		} else {
			req.Header.Del("Authorization")
		}
	}
	proxy.FlushInterval = 100 * time.Millisecond // SSE-friendly
	proxy.ServeHTTP(w, r)
}

// handleStop deletes the config file. The supervisor sees the missing
// file on its next iteration and goes idle (which terminates the
// llama-server child).
func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	if err := svcconfig.DeleteConfig(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete config: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accepted": true,
		"note":     "supervisor will stop the child within ~5s",
	})
}

// ─── Token persistence ──────────────────────────────────────────────

func tokenPath() (string, error) {
	root, err := paths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, TokenFile), nil
}

func loadOrCreateToken() (string, error) {
	path, err := tokenPath()
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(path)
	if err == nil {
		t := strings.TrimSpace(string(b))
		if t != "" {
			return t, nil
		}
	}
	// Generate 32 bytes of entropy → URL-safe base64 (no padding).
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(token), 0o600); err != nil {
		return "", err
	}
	return token, nil
}

// ─── Helpers ────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

// parseModelFile extracts the catalog id and quant from a GGUF filename
// of the form  "Qwen2.5-7B-Instruct-Q4_K_M.gguf"  →  ("qwen-2.5-7b-instruct", "q4").
// Lossy; the real source of truth is the catalog, this is just for
// surfacing files we don't have catalog metadata for.
func parseModelFile(name string) (id, quant string) {
	stem := strings.TrimSuffix(name, ".gguf")
	stem = strings.TrimSuffix(stem, ".GGUF")
	// Find the last "-Q\d" or "-q\d" group as the quant.
	for i := len(stem) - 1; i >= 1; i-- {
		if stem[i-1] != '-' {
			continue
		}
		tail := stem[i:]
		if len(tail) >= 2 && (tail[0] == 'q' || tail[0] == 'Q') && tail[1] >= '0' && tail[1] <= '9' {
			return strings.ToLower(stem[:i-1]), strings.ToLower(string(tail[0]) + string(tail[1]))
		}
	}
	return strings.ToLower(stem), ""
}
