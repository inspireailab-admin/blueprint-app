// SSH IPC — test-connect + push-install for the host registry.
//
// TestConnect opens a one-shot SSH session against a registered host
// and runs `uname -a` + a few cheap probes (CPU count, total memory).
// Updates LastSeenAtMs on success. Returns a structured verdict the
// HostsExplorer renders next to the row.
//
// PushInstall runs the install-linux.sh script over SSH with stdout
// + stderr streamed line-by-line back to the frontend via Wails
// events. Push-install is the path that actually puts a working
// blueprint-svc on the remote host.

package main

import (
	"context"
	"embed"
	"fmt"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	bpssh "github.com/inspireailab-admin/blueprint-app/internal/ssh"
)

// installerAssets embeds the install-linux.sh script AND a cross-
// compiled blueprint-svc-linux binary so push-install can SCP both
// to a fresh host without a network round-trip and without the user
// having to pre-stage anything.
//
// The svc binary is cross-compiled into build/bin/blueprint-svc-linux
// before each wails build. See README → "Building" for the one-line
// command. CI does this automatically in .github/workflows/release.yml.
//
//go:embed installer/install-linux.sh build/bin/blueprint-svc-linux
var installerAssets embed.FS

// HostProbeResult is what TestConnect reports back to the UI.
type HostProbeResult struct {
	ID         string `json:"id"`
	Reachable  bool   `json:"reachable"`
	LatencyMs  int64  `json:"latencyMs"`
	Uname      string `json:"uname,omitempty"`
	OSPretty   string `json:"osPretty,omitempty"`
	CPUCount   int    `json:"cpuCount,omitempty"`
	MemTotalGB int    `json:"memTotalGB,omitempty"`
	GPUSummary string `json:"gpuSummary,omitempty"`
	Error      string `json:"error,omitempty"`
}

// TestHostConnection runs a short fact-finding session against the
// host with the given ID.
func (a *App) TestHostConnection(id string) HostProbeResult {
	out := HostProbeResult{ID: id}

	h, ok := getHosts().Get(id)
	if !ok {
		out.Error = "host not found in registry"
		return out
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	t0 := time.Now()
	client, err := bpssh.Dial(ctx, bpssh.Config{
		User:    h.User,
		Host:    h.Host,
		Port:    h.Port,
		KeyPath: h.KeyPath,
	})
	if err != nil {
		out.Error = err.Error()
		return out
	}
	defer client.Close()
	out.LatencyMs = time.Since(t0).Milliseconds()
	out.Reachable = true

	// Each probe failure is non-fatal; the user gets whatever we
	// could pull. We chain them with `; ` so one failed step doesn't
	// silently swallow the rest.
	if s, err := client.Run(ctx, "uname -a"); err == nil {
		out.Uname = strings.TrimSpace(s)
	}
	if s, err := client.Run(ctx, "cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'"); err == nil {
		out.OSPretty = strings.TrimSpace(s)
	}
	if s, err := client.Run(ctx, "nproc"); err == nil {
		if n := parseInt(strings.TrimSpace(s)); n > 0 {
			out.CPUCount = n
		}
	}
	if s, err := client.Run(ctx, `awk '/MemTotal/ {print int($2/1024/1024)}' /proc/meminfo`); err == nil {
		if g := parseInt(strings.TrimSpace(s)); g > 0 {
			out.MemTotalGB = g
		}
	}
	if s, err := client.Run(ctx, `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -4`); err == nil {
		out.GPUSummary = strings.TrimSpace(s)
	}

	getHosts().TouchSeen(id)
	return out
}

// PushInstallEventChannel is the Wails event name the frontend listens
// on for streamed install lines.
const PushInstallEventChannel = "host:install:line"

// PushInstallResult tells the UI whether the install succeeded.
type PushInstallResult struct {
	ID       string `json:"id"`
	OK       bool   `json:"ok"`
	ExitCode int    `json:"exitCode"`
	Error    string `json:"error,omitempty"`
}

// PushInstallHost ships install-linux.sh to the remote host and runs
// it under sudo (the script enforces root). stdout/stderr stream
// back to the frontend via host:install:line events tagged with the
// host ID.
//
// Phase B.2 ships the script-only install (kernel binaries are
// downloaded by the script from GitHub Releases). Phase C will
// SCP a known-good svc binary directly for users who don't want
// the install script touching the network.
func (a *App) PushInstallHost(id string) PushInstallResult {
	out := PushInstallResult{ID: id, ExitCode: -1}

	h, ok := getHosts().Get(id)
	if !ok {
		out.Error = "host not found in registry"
		return out
	}

	script, err := installerAssets.ReadFile("installer/install-linux.sh")
	if err != nil {
		out.Error = fmt.Sprintf("read embedded install-linux.sh: %v", err)
		return out
	}
	svcBin, err := installerAssets.ReadFile("build/bin/blueprint-svc-linux")
	if err != nil {
		out.Error = fmt.Sprintf("read embedded blueprint-svc-linux: %v", err)
		return out
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	emit := func(stream, line string) {
		runtime.EventsEmit(a.ctx, PushInstallEventChannel, map[string]any{
			"id":     id,
			"stream": stream,
			"line":   line,
		})
	}

	client, err := bpssh.Dial(ctx, bpssh.Config{
		User:    h.User,
		Host:    h.Host,
		Port:    h.Port,
		KeyPath: h.KeyPath,
	})
	if err != nil {
		out.Error = err.Error()
		emit("stderr", "[dial] "+err.Error())
		return out
	}
	defer client.Close()

	// Ship the svc binary first so the install script finds it adjacent
	// to itself (its lookup is `${here}/blueprint-svc-linux`).
	remoteSvc := "/tmp/blueprint-svc-linux"
	emit("stdout", fmt.Sprintf("[upload] sending blueprint-svc-linux (%d bytes) -> %s", len(svcBin), remoteSvc))
	if err := client.WriteFile(ctx, remoteSvc, 0o755, svcBin); err != nil {
		out.Error = "upload svc binary: " + err.Error()
		emit("stderr", "[upload] "+err.Error())
		return out
	}

	remoteScript := "/tmp/blueprint-install-linux.sh"
	emit("stdout", "[upload] sending install-linux.sh -> "+remoteScript)
	if err := client.WriteFile(ctx, remoteScript, 0o755, script); err != nil {
		out.Error = "upload install script: " + err.Error()
		emit("stderr", "[upload] "+err.Error())
		return out
	}

	// The script asserts root via $EUID. If we're already root no
	// sudo prefix is needed; otherwise we use `sudo -n` (non-
	// interactive) so the user gets a clear "needs passwordless
	// sudo" error instead of a hang.
	sudo := "sudo -n "
	if h.User == "root" {
		sudo = ""
	}
	emit("stdout", "[run] "+sudo+remoteScript)

	exitCode, err := client.RunStream(ctx, sudo+remoteScript, emit)
	if err != nil {
		out.Error = err.Error()
		emit("stderr", "[run] "+err.Error())
		return out
	}
	out.ExitCode = exitCode
	out.OK = exitCode == 0
	if out.OK {
		getHosts().TouchSeen(id)
		emit("stdout", "[done] install succeeded")
	} else {
		emit("stderr", fmt.Sprintf("[done] install exited %d", exitCode))
	}
	return out
}

func parseInt(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
	}
	return n
}
