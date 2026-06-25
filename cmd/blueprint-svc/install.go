//go:build windows

// Service install / uninstall / status — wraps the SCM mgr package
// with a fixed name + display + description so callers don't have to
// repeat themselves.
//
// Run from an elevated process. The desktop app accomplishes that by
// invoking blueprint-svc.exe via ShellExecute with the "runas" verb.

package main

import (
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

func installService() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate self: %w", err)
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w (re-run as administrator?)", err)
	}
	defer m.Disconnect()

	if existing, err := m.OpenService(svcconfig.ServiceName); err == nil {
		existing.Close()
		return fmt.Errorf("service %q already installed", svcconfig.ServiceName)
	}

	s, err := m.CreateService(svcconfig.ServiceName, exe, mgr.Config{
		DisplayName: svcconfig.ServiceDisplayName,
		Description: svcconfig.ServiceDescription,
		StartType:   mgr.StartAutomatic,
		ServiceType: 0x10, // SERVICE_WIN32_OWN_PROCESS
	})
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()

	// Recovery: restart on first three failures with a 5s delay, then
	// give up. Belt to the supervisor's own restart loop — SCM-level
	// recovery covers the case where the supervisor itself panics.
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
	}, 86_400); err != nil {
		// Non-fatal; the service still installs.
	}

	if err := s.Start(); err != nil {
		// Service is registered but failed to start. Leave it
		// installed so the user can investigate via services.msc.
		return fmt.Errorf("start service: %w", err)
	}
	return nil
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(svcconfig.ServiceName)
	if err != nil {
		return fmt.Errorf("open service: %w", err)
	}
	defer s.Close()

	// Try to stop first; ignore "already stopped" errors.
	_, _ = s.Control(svc.Stop)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		st, err := s.Query()
		if err != nil {
			break
		}
		if st.State == svc.Stopped {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}

	if err := s.Delete(); err != nil {
		return fmt.Errorf("delete service: %w", err)
	}
	_ = svcconfig.DeleteConfig()
	_ = svcconfig.DeleteStatus()
	return nil
}

func startService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcconfig.ServiceName)
	if err != nil {
		return fmt.Errorf("open service: %w", err)
	}
	defer s.Close()
	return s.Start()
}

func stopService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect SCM: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcconfig.ServiceName)
	if err != nil {
		return fmt.Errorf("open service: %w", err)
	}
	defer s.Close()
	_, err = s.Control(svc.Stop)
	return err
}

func printStatus() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(svcconfig.ServiceName)
	if err != nil {
		fmt.Println("not installed")
		return nil
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return err
	}
	fmt.Printf("SCM state: %v\n", st.State)
	if status, _ := svcconfig.ReadStatus(); status != nil {
		fmt.Printf("supervisor phase: %s\n", status.Phase)
		fmt.Printf("model: %s %s\n", status.ModelID, status.Quant)
		fmt.Printf("pid: %d\n", status.PID)
		fmt.Printf("restarts: %d\n", status.RestartCount)
		if status.LastError != "" {
			fmt.Printf("last error: %s\n", status.LastError)
		}
	}
	return nil
}
