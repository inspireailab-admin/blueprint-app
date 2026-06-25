//go:build windows

// Windows bridge for the supervisor — implements svc.Handler so the
// SCM can drive runSupervisor. All the actual supervision logic lives
// in supervisor.go (cross-platform); this file is just the wiring.

package main

import (
	"context"
	"log"
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

			// CRITICAL: kill the child SYNCHRONOUSLY before we cancel
			// the worker context or return from Execute.
			//
			// The previous order — cancel() first, with a 5-second
			// Kill scheduled in a goroutine as backup — was racy:
			// cancel() asks Go's runtime to TerminateProcess via its
			// own goroutine, and the 5-second backup also fired in a
			// goroutine. If the worker finished fast and Execute
			// returned, blueprint-svc.exe exited and ALL of those
			// goroutines died with it — leaving llama-server orphaned.
			// Repeating the cycle a few times produced multiple
			// orphaned llama-servers, one of which was answering on
			// 8080 with a stale api_key, and chat 401'd against it.
			//
			// Process.Kill on Windows is TerminateProcess, which is
			// synchronous: by the time it returns, the child is gone.
			if cmd, cc := tracker.snapshot(); cmd != nil && cmd.Process != nil {
				if err := cmd.Process.Kill(); err != nil {
					log.Printf("supervisor: kill child pid=%d: %v", cmd.Process.Pid, err)
				}
				if cc != nil {
					cc()
				}
			}

			// Now cancel the worker ctx — the worker's cmd.Wait()
			// returned (because the child is dead) and it'll see
			// ctx.Err() and exit cleanly.
			cancel()

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
