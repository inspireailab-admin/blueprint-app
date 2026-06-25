//go:build !windows

package pyruntime

import "os/exec"

// hideCmdWindow is a no-op outside Windows.
func hideCmdWindow(cmd *exec.Cmd) { _ = cmd }
