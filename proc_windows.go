//go:build windows

// Windows-specific subprocess hardening. Without this, every exec.Command
// pops a black CMD window for the duration of the call — fine for
// developers running blueprint from a terminal, very wrong for a
// shipped desktop app where the user sees windows flash every 2 s as
// nvidia-smi polls.
//
// hideConsole sets the CREATE_NO_WINDOW process flag so the spawned
// child runs without an attached console. Applied to:
//   - nvidia-smi polls (monitor.go)
//   - llama-server supervision (deploy.go)
//   - any future exec.Command we add
//
// Author: Amar Mond.
package main

import (
	"os/exec"
	"syscall"
)

const windowsCreateNoWindow = 0x08000000

// hideConsole configures a Cmd so its child process doesn't get a
// console window on Windows. Safe to call before Start / Run.
func hideConsole(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	attr := cmd.SysProcAttr
	attr.HideWindow = true
	attr.CreationFlags |= windowsCreateNoWindow
}
