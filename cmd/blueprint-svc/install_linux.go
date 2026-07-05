//go:build linux

// Linux service install — writes a systemd unit, copies the binary
// into /usr/local/bin, enables + starts it. Symmetric uninstall.
//
// Requires root. We don't try to elevate ourselves — print a clear
// error pointing at `sudo`. The Blueprint installer (next iteration)
// invokes us via sudo / pkexec so the user only authenticates once.
//
// Author: Amar Mond.
package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

const (
	systemdUnitName = "blueprint-llm.service"
	systemdUnitPath = "/etc/systemd/system/blueprint-llm.service"
	installedBin    = "/usr/local/bin/blueprint-svc"
)

const systemdUnitTemplate = `[Unit]
Description=Blueprint LLM Service — supervises llama-server for the Blueprint desktop app
After=network.target
Wants=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/blueprint-svc
Restart=always
RestartSec=5
# Service writes config + status under /var/lib/blueprint (DataDir on Linux).
Environment=BLUEPRINT_SERVICE_DATA=/var/lib/blueprint
# Don't share signals with the rest of the user's session.
KillMode=control-group
TimeoutStopSec=15
StandardOutput=append:/var/log/blueprint-svc.log
StandardError=append:/var/log/blueprint-svc.log

[Install]
WantedBy=multi-user.target
`

func installService() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("install requires root — re-run with sudo")
	}

	// 1. Copy our own binary to /usr/local/bin/blueprint-svc.
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate self: %w", err)
	}
	if self != installedBin {
		if err := copyFile(self, installedBin, 0o755); err != nil {
			return fmt.Errorf("copy binary: %w", err)
		}
	}

	// 2. Write the systemd unit. If an enrollment code is configured (the
	//    Blueprint installer sets BLUEPRINT_ENROLL_CODE), bake it into the unit
	//    so the svc enrolls with the relay on start. The code contains a secret,
	//    so a unit carrying one is written root-only (0600).
	unit := systemdUnitTemplate
	mode := os.FileMode(0o644)
	if code := os.Getenv("BLUEPRINT_ENROLL_CODE"); code != "" {
		unit = injectEnv(unit, "BLUEPRINT_ENROLL_CODE", code)
		if url := os.Getenv("BLUEPRINT_RELAY_URL"); url != "" {
			unit = injectEnv(unit, "BLUEPRINT_RELAY_URL", url)
		}
		mode = 0o600
	}
	if err := os.WriteFile(systemdUnitPath, []byte(unit), mode); err != nil {
		return fmt.Errorf("write unit: %w", err)
	}

	// 3. Create /var/lib/blueprint so the supervisor can write status.
	if err := os.MkdirAll("/var/lib/blueprint", 0o755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}

	// 4. daemon-reload, enable, start.
	if err := systemctl("daemon-reload"); err != nil {
		return err
	}
	if err := systemctl("enable", systemdUnitName); err != nil {
		return err
	}
	if err := systemctl("start", systemdUnitName); err != nil {
		return err
	}
	return nil
}

func uninstallService() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("uninstall requires root — re-run with sudo")
	}
	_ = systemctl("stop", systemdUnitName)
	_ = systemctl("disable", systemdUnitName)
	_ = os.Remove(systemdUnitPath)
	_ = systemctl("daemon-reload")
	_ = svcconfig.DeleteConfig()
	_ = svcconfig.DeleteStatus()
	return nil
}

func startService() error {
	return systemctl("start", systemdUnitName)
}

func stopService() error {
	return systemctl("stop", systemdUnitName)
}

func printStatus() error {
	if err := systemctl("status", systemdUnitName); err != nil {
		// systemctl status returns non-zero for inactive — that's not
		// an error from our perspective. Print whatever the user
		// already saw.
	}
	if st, _ := svcconfig.ReadStatus(); st != nil {
		fmt.Printf("supervisor phase: %s\n", st.Phase)
		fmt.Printf("model: %s %s\n", st.ModelID, st.Quant)
		fmt.Printf("pid: %d\n", st.PID)
		fmt.Printf("restarts: %d\n", st.RestartCount)
		if st.LastError != "" {
			fmt.Printf("last error: %s\n", st.LastError)
		}
	}
	return nil
}

// injectEnv adds an Environment= line to the [Service] section, right after the
// existing BLUEPRINT_SERVICE_DATA line.
func injectEnv(unit, key, value string) string {
	anchor := "Environment=BLUEPRINT_SERVICE_DATA=/var/lib/blueprint"
	return strings.Replace(unit, anchor, anchor+"\nEnvironment="+key+"="+value, 1)
}

func systemctl(args ...string) error {
	cmd := exec.Command("systemctl", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
