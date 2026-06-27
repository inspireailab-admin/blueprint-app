//go:build !windows

// macOS + Linux don't get a console window on exec — child processes
// are silent unless we wire stdout/stderr. Keep hideConsole a no-op
// on these platforms so calling code is portable.
//
// Author: Amar Mond.
package main

import "os/exec"

func hideConsole(cmd *exec.Cmd) {
	_ = cmd
}
