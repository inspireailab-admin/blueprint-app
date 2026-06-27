//go:build !windows
//
// Author: Amar Mond.
package pyruntime

import "os/exec"

// hideCmdWindow is a no-op outside Windows.
func hideCmdWindow(cmd *exec.Cmd) { _ = cmd }
