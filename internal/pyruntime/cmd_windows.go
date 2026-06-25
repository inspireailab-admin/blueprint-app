//go:build windows

package pyruntime

import (
	"os/exec"
	"syscall"
)

// hideCmdWindow keeps uv's console window from flashing on Windows
// during long-running pip installs.
func hideCmdWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}
