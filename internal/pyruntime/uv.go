// uv wrappers — detect, download, invoke.
//
// uv is astral.sh's pure-Rust Python toolchain. We ship it as a single
// binary at ~/.blueprint/python/uv.exe (Linux: uv). The first call to
// any Python-side feature triggers a download from
// https://github.com/astral-sh/uv/releases — single static binary, no
// extraction archive, no installer.

package pyruntime

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// uvRelease is the version we pin to. Keeping this hand-bumped means
// we know the wire format of `uv pip install --dry-run` etc. didn't
// change underneath us between Blueprint releases.
const uvRelease = "0.5.4"

// UvDownloadURL returns the platform-specific URL for the pinned uv
// release. uv ships zip on Windows, tar.gz on Unix; we use the
// "no-archive" single-binary builds where they exist.
func UvDownloadURL() string {
	base := "https://github.com/astral-sh/uv/releases/download/" + uvRelease + "/"
	switch runtime.GOOS {
	case "windows":
		switch runtime.GOARCH {
		case "amd64":
			return base + "uv-x86_64-pc-windows-msvc.zip"
		case "arm64":
			return base + "uv-aarch64-pc-windows-msvc.zip"
		}
	case "linux":
		switch runtime.GOARCH {
		case "amd64":
			return base + "uv-x86_64-unknown-linux-gnu.tar.gz"
		case "arm64":
			return base + "uv-aarch64-unknown-linux-gnu.tar.gz"
		}
	case "darwin":
		switch runtime.GOARCH {
		case "amd64":
			return base + "uv-x86_64-apple-darwin.tar.gz"
		case "arm64":
			return base + "uv-aarch64-apple-darwin.tar.gz"
		}
	}
	return ""
}

// UvPresent reports whether the uv binary is already on disk.
func UvPresent() bool {
	path, err := UvPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}

// DownloadUv fetches the pinned uv binary into ~/.blueprint/python/.
// Progress is reported via the optional callback (bytes downloaded /
// total) so the UI can render a bar.
//
// uv ships as a compressed archive containing one binary; we extract
// that binary in place. For the zip variant on Windows we use
// archive/zip; for tar.gz we use archive/tar + gzip. Both std-lib,
// no extra dependency.
func DownloadUv(ctx context.Context, onProgress func(bytesDone, bytesTotal int64)) error {
	url := UvDownloadURL()
	if url == "" {
		return fmt.Errorf("no uv release for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	dir, err := RuntimeDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	// Stream the archive to a temp file. Don't try to extract from a
	// network response — slow networks + retries get messy.
	tmp, err := os.CreateTemp(dir, "uv-download-*.archive")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	defer tmp.Close()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download uv: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download uv: HTTP %d", resp.StatusCode)
	}

	total := resp.ContentLength
	r := &progressReader{r: resp.Body, total: total, onProgress: onProgress}
	if _, err := io.Copy(tmp, r); err != nil {
		return fmt.Errorf("write uv archive: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	// Extract.
	outPath, err := UvPath()
	if err != nil {
		return err
	}
	if strings.HasSuffix(url, ".zip") {
		if err := extractUvFromZip(tmpPath, outPath); err != nil {
			return err
		}
	} else {
		if err := extractUvFromTarGz(tmpPath, outPath); err != nil {
			return err
		}
	}
	// Make executable on Unix.
	if runtime.GOOS != "windows" {
		_ = os.Chmod(outPath, 0o755)
	}
	return nil
}

// progressReader wraps an io.Reader and reports byte counts.
type progressReader struct {
	r          io.Reader
	read       int64
	total      int64
	onProgress func(int64, int64)
}

func (p *progressReader) Read(buf []byte) (int, error) {
	n, err := p.r.Read(buf)
	if n > 0 {
		p.read += int64(n)
		if p.onProgress != nil {
			p.onProgress(p.read, p.total)
		}
	}
	return n, err
}

// ─── uv invocation ────────────────────────────────────────────────────────

// RunUv runs uv with the given args and streams its combined output
// to the callback. Returns the exit error if any.
func RunUv(ctx context.Context, args []string, onLine func(string)) error {
	if !UvPresent() {
		return fmt.Errorf("uv binary not installed")
	}
	uv, _ := UvPath()
	cmd := exec.CommandContext(ctx, uv, args...)
	hideCmdWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go streamLines(stdout, onLine)
	go streamLines(stderr, onLine)
	return cmd.Wait()
}

func streamLines(r io.Reader, onLine func(string)) {
	if onLine == nil {
		_, _ = io.Copy(io.Discard, r)
		return
	}
	buf := make([]byte, 4096)
	var rest []byte
	for {
		n, err := r.Read(buf)
		if n > 0 {
			rest = append(rest, buf[:n]...)
			for {
				idx := indexOfNewline(rest)
				if idx < 0 {
					break
				}
				line := strings.TrimRight(string(rest[:idx]), "\r")
				if line != "" {
					onLine(line)
				}
				rest = rest[idx+1:]
			}
		}
		if err != nil {
			if len(rest) > 0 {
				onLine(strings.TrimSpace(string(rest)))
			}
			return
		}
	}
}

func indexOfNewline(b []byte) int {
	for i, c := range b {
		if c == '\n' {
			return i
		}
	}
	return -1
}

// EnsureCorePackages bootstraps a Python install + venv + minimum
// packages. Called as the first install step before any feature.
func EnsureCorePackages(ctx context.Context, onLine func(string)) error {
	dir, err := RuntimeDir()
	if err != nil {
		return err
	}
	pythonDir := filepath.Join(dir, "python-3.11")
	venvDir, _ := VenvPath()

	// 1. Install Python 3.11 via uv.
	onLine("Installing Python 3.11 via uv…")
	if err := RunUv(ctx, []string{
		"python", "install", "3.11",
		"--install-dir", pythonDir,
	}, onLine); err != nil {
		return fmt.Errorf("uv python install: %w", err)
	}

	// 2. Create the venv.
	onLine("Creating venv at " + venvDir)
	if err := RunUv(ctx, []string{
		"venv", venvDir,
		"--python", "3.11",
	}, onLine); err != nil {
		return fmt.Errorf("uv venv: %w", err)
	}

	return nil
}

// InstallPipPackages runs `uv pip install` with the configured
// packages, targeting our managed venv.
func InstallPipPackages(ctx context.Context, packages []string, indexURL string, onLine func(string)) error {
	if len(packages) == 0 {
		return nil
	}
	venv, err := VenvPath()
	if err != nil {
		return err
	}
	args := []string{"pip", "install", "--python", venv}
	if indexURL != "" {
		args = append(args, "--index-url", indexURL)
	}
	args = append(args, packages...)
	return RunUv(ctx, args, onLine)
}

// UninstallPipPackages drops a feature's packages from the venv.
func UninstallPipPackages(ctx context.Context, packages []string, onLine func(string)) error {
	if len(packages) == 0 {
		return nil
	}
	venv, err := VenvPath()
	if err != nil {
		return err
	}
	args := []string{"pip", "uninstall", "--python", venv, "--yes"}
	args = append(args, packages...)
	return RunUv(ctx, args, onLine)
}
