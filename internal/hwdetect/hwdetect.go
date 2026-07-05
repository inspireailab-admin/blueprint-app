// Package hwdetect detects the local machine's GPUs, CPU, and RAM. Importable
// (unlike the desktop app's package-main monitor.go and svcapi's unexported
// readGPUs) so the remote agent can report hardware to the desktop.
package hwdetect

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v4/mem"
)

// GPU is one detected accelerator.
type GPU struct {
	Index       int    `json:"index"`
	Name        string `json:"name"`
	Vendor      string `json:"vendor"`
	VRAMTotalMB int    `json:"vramTotalMB"`
	VRAMFreeMB  int    `json:"vramFreeMB"`
}

// Snapshot is the detected hardware.
type Snapshot struct {
	OS         string  `json:"os"`
	CPUCores   int     `json:"cpuCores"`
	RAMTotalGB float64 `json:"ramTotalGB"`
	RAMFreeGB  float64 `json:"ramFreeGB"`
	GPUs       []GPU   `json:"gpus"`
}

const gib = 1024 * 1024 * 1024

// Detect returns the current hardware snapshot. GPU detection is best-effort
// (NVIDIA via nvidia-smi); no driver → empty GPU list, not an error.
func Detect(ctx context.Context) Snapshot {
	s := Snapshot{
		OS:       osLabel(),
		CPUCores: runtime.NumCPU(),
		GPUs:     detectNvidia(ctx),
	}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		s.RAMTotalGB = round1(float64(vm.Total) / gib)
		s.RAMFreeGB = round1(float64(vm.Available) / gib)
	}
	return s
}

// detectNvidia parses `nvidia-smi --query-gpu=index,name,memory.total,memory.free`.
func detectNvidia(ctx context.Context) []GPU {
	cmd := exec.CommandContext(ctx, "nvidia-smi",
		"--query-gpu=index,name,memory.total,memory.free",
		"--format=csv,noheader,nounits")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var gpus []GPU
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		fields := strings.Split(sc.Text(), ",")
		if len(fields) < 4 {
			continue
		}
		gpus = append(gpus, GPU{
			Index:       atoi(strings.TrimSpace(fields[0])),
			Name:        strings.TrimSpace(fields[1]),
			Vendor:      "nvidia",
			VRAMTotalMB: atoi(strings.TrimSpace(fields[2])),
			VRAMFreeMB:  atoi(strings.TrimSpace(fields[3])),
		})
	}
	return gpus
}

func osLabel() string {
	if runtime.GOOS == "linux" {
		if b, err := os.ReadFile("/etc/os-release"); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if strings.HasPrefix(line, "PRETTY_NAME=") {
					return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
				}
			}
		}
	}
	return runtime.GOOS
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func round1(f float64) float64 {
	return float64(int(f*10+0.5)) / 10
}
