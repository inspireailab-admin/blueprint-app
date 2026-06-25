//go:build windows

// Windows bridge for the supervisor — implements svc.Handler so the
// SCM can drive runSupervisor. All the actual supervision logic lives
// in supervisor.go (cross-platform); this file is just the wiring.

package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"syscall"
	"time"

	"golang.org/x/sys/windows/svc"

	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
)

type supervisor struct{}

func (s *supervisor) Execute(args []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	status <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	tracker := &childTracker{}

	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		runSupervisor(ctx, runSupervisorOpts{
			onChildStart: tracker.set,
			onChildEnd:   tracker.clear,
		})
	}()

	status <- svc.Status{State: svc.Running, Accepts: accepted}

	for c := range r {
		switch c.Cmd {
		case svc.Interrogate:
			status <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			cancel()

			// 5s grace, then hard-kill.
			if cmd, cc := tracker.snapshot(); cmd != nil && cmd.Process != nil {
				go func(p *os.Process) {
					time.Sleep(5 * time.Second)
					_ = p.Kill()
				}(cmd.Process)
				if cc != nil {
					cc()
				}
			}

			select {
			case <-workerDone:
			case <-time.After(10 * time.Second):
				log.Printf("supervisor: worker didn't exit in 10s, force-returning")
			}

			writeStatus(svcconfig.Status{Phase: "stopped"})
			return false, 0
		}
	}
	return false, 0
}

// hideConsole hides the child llama-server's window on Windows.
func hideConsole(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}
