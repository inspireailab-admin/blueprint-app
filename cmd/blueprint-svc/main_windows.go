//go:build windows

// Blueprint LLM Service — supervises a llama-server child as a proper
// Windows Service, so the local LLM stays up across reboots and the
// desktop app's exit. This is what makes Blueprint a corporate-grade
// runtime rather than a session-lived toy.
//
// Three modes of operation, selected by CLI arg (or absence thereof):
//
//   blueprint-svc.exe                ← SCM-launched; runs as a service.
//   blueprint-svc.exe install        ← register with SCM + start (admin).
//   blueprint-svc.exe uninstall      ← stop + delete from SCM (admin).
//   blueprint-svc.exe status         ← print SCM + supervisor state.
//   blueprint-svc.exe debug          ← run interactively for dev work.
//
// All persistent state (desired config, observed status, child log)
// lives under %ProgramData%\Blueprint so the desktop app (user) and
// service (LocalSystem) share a single source of truth.

package main

import (
	"fmt"
	"log"
	"os"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/debug"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

func main() {
	// Open a file logger early so service-mode failures show up
	// somewhere — stderr is meaningless under SCM.
	_ = svcconfig.EnsureDataDir()
	if logPath, err := svcconfig.DataDir(); err == nil {
		f, err := os.OpenFile(logPath+`\service.log`,
			os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			log.SetOutput(f)
		}
	}

	if len(os.Args) > 1 {
		cmd := os.Args[1]
		switch cmd {
		case "install":
			if err := installService(); err != nil {
				fmt.Fprintln(os.Stderr, "install:", err)
				os.Exit(1)
			}
			fmt.Println("installed and started")
			return
		case "uninstall":
			if err := uninstallService(); err != nil {
				fmt.Fprintln(os.Stderr, "uninstall:", err)
				os.Exit(1)
			}
			fmt.Println("uninstalled")
			return
		case "start":
			if err := startService(); err != nil {
				fmt.Fprintln(os.Stderr, "start:", err)
				os.Exit(1)
			}
			return
		case "stop":
			if err := stopService(); err != nil {
				fmt.Fprintln(os.Stderr, "stop:", err)
				os.Exit(1)
			}
			return
		case "status":
			if err := printStatus(); err != nil {
				fmt.Fprintln(os.Stderr, "status:", err)
				os.Exit(1)
			}
			return
		case "debug":
			if err := debug.Run(svcconfig.ServiceName, &supervisor{}); err != nil {
				log.Fatalf("debug run: %v", err)
			}
			return
		}
		fmt.Fprintf(os.Stderr, "unknown command %q\n", cmd)
		os.Exit(2)
	}

	// No args — SCM is launching us as a service.
	isService, err := svc.IsWindowsService()
	if err != nil {
		log.Fatalf("determine session: %v", err)
	}
	if !isService {
		fmt.Fprintln(os.Stderr, "blueprint-svc: run as a Windows service, or pass 'install' / 'debug'")
		os.Exit(2)
	}
	if err := svc.Run(svcconfig.ServiceName, &supervisor{}); err != nil {
		log.Fatalf("service run: %v", err)
	}
}
