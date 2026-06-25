//go:build linux

// Linux entry point. On Linux there's no SCM — systemd just exec's
// this binary and expects it to handle SIGTERM cleanly. The
// supervisor loop runs inline; the only platform glue we need is
// signal handling + child-kill on shutdown.
//
// Subcommands match the Windows binary:
//
//   blueprint-svc install        ← writes /etc/systemd/system unit (root).
//   blueprint-svc uninstall      ← stops + removes unit (root).
//   blueprint-svc start          ← systemctl start.
//   blueprint-svc stop           ← systemctl stop.
//   blueprint-svc status         ← prints SCM + supervisor state.
//   blueprint-svc                ← runs the supervisor inline (what
//                                  systemd ExecStart= calls).

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

func main() {
	_ = svcconfig.EnsureDataDir()
	if dir, err := svcconfig.DataDir(); err == nil {
		if f, err := os.OpenFile(dir+"/service.log",
			os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
			log.SetOutput(f)
		}
	}

	if len(os.Args) > 1 {
		switch os.Args[1] {
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
		}
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		os.Exit(2)
	}

	// No args — systemd is invoking us. Run the supervisor.
	ctx, cancel := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	tracker := &childTracker{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		runSupervisor(ctx, runSupervisorOpts{
			onChildStart: tracker.set,
			onChildEnd:   tracker.clear,
		})
	}()

	<-ctx.Done()
	log.Printf("supervisor: signal received, stopping")

	// SIGTERM the child immediately, hard-kill after 5s.
	if cmd, cc := tracker.snapshot(); cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		go func(p *os.Process) {
			time.Sleep(5 * time.Second)
			_ = p.Kill()
		}(cmd.Process)
		if cc != nil {
			cc()
		}
	}

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		log.Printf("supervisor: worker didn't exit in 10s, force-exiting")
	}

	writeStatus(svcconfig.Status{Phase: "stopped"})
}

// hideConsole is a no-op on Linux; defined here so supervisor.go can
// call it without a build tag.
func hideConsole(cmd *exec.Cmd) { _ = cmd }
