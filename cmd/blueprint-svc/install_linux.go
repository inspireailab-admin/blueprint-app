//go:build linux

// Linux service install — writes a systemd unit, copies the binary
// into /usr/local/bin, enables + starts it. Symmetric uninstall.
//
// Requires root. We don't try to elevate ourselves — print a clear
// error pointing at `sudo`. The Blueprint installer (next iteration)
// invokes us via sudo / pkexec so the user only authenticates once.

package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"

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

	// 2. Write the systemd unit.
	if err := os.WriteFile(systemdUnitPath, []byte(systemdUnitTemplate), 0o644); err != nil {
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
