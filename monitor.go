// Monitor IPC surface. Polls CPU + RAM via gopsutil and GPU via nvidia-smi
// at a fixed interval, emits each sample to the frontend as a
// monitor:snapshot event.
//
// The Monitor tab subscribes on mount and stops polling on unmount —
// when the tab isn't visible we don't burn cycles on samples nobody
// will see.

package main

import (
	"context"
	"encoding/csv"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Gpu is one entry in the per-GPU breakdown. Stays empty when the host
// has no NVIDIA driver (e.g. an Apple Silicon laptop or pure CPU box).
type Gpu struct {
	Index       int    `json:"index"`
	Name        string `json:"name"`
	VramTotalMB int    `json:"vramTotalMB"`
	VramUsedMB  int    `json:"vramUsedMB"`
	VramFreeMB  int    `json:"vramFreeMB"`
	UtilPct     int    `json:"utilPct"`
	TempC       int    `json:"tempC"`
}

// Snapshot is one tick of system state. Sent over Wails events at the
// configured polling interval.
type Snapshot struct {
	Timestamp     int64   `json:"timestamp"`
	HasGpuDriver  bool    `json:"hasGpuDriver"`
	GpuVendor     string  `json:"gpuVendor,omitempty"`
	Gpus          []Gpu   `json:"gpus"`
	CpuUtilPct    float64 `json:"cpuUtilPct"`
	RamTotalBytes uint64  `json:"ramTotalBytes"`
	RamUsedBytes  uint64  `json:"ramUsedBytes"`
	RamUsedPct    float64 `json:"ramUsedPct"`
}

// monitorCancel and monitorMu coordinate the single background polling
// goroutine. Only one polling loop runs at a time even if StartMonitoring
// is called multiple times by accident.
var (
	monitorMu     sync.Mutex
	monitorCancel context.CancelFunc
)

// Snapshot returns the current system state synchronously. Used by the
// Monitor tab on mount to render the first frame before the polling
// loop's first tick lands.
func (a *App) Snapshot() Snapshot {
	return takeSnapshot()
}

// StartMonitoring spins up a background ticker that emits snapshots over
// monitor:snapshot every `intervalMs` milliseconds. Idempotent — calling
// again is a no-op while a loop is already running. Pass 0 to use the
// default 2 s interval.
func (a *App) StartMonitoring(intervalMs int) {
	if intervalMs < 250 {
		intervalMs = 2000
	}
	monitorMu.Lock()
	if monitorCancel != nil {
		monitorMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	monitorCancel = cancel
	monitorMu.Unlock()

	go func() {
		ticker := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
		defer ticker.Stop()

		// Emit one immediately so the UI updates fast on mount.
		wailsruntime.EventsEmit(a.ctx, "monitor:snapshot", takeSnapshot())

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				wailsruntime.EventsEmit(a.ctx, "monitor:snapshot", takeSnapshot())
			}
		}
	}()
}

// StopMonitoring tears down the background ticker. Safe to call from
// any goroutine.
func (a *App) StopMonitoring() {
	monitorMu.Lock()
	defer monitorMu.Unlock()
	if monitorCancel != nil {
		monitorCancel()
		monitorCancel = nil
	}
}

// takeSnapshot collects one tick of system state. Each subsystem is
// best-effort — a failure on GPU shouldn't drop CPU or RAM data.
func takeSnapshot() Snapshot {
	s := Snapshot{Timestamp: time.Now().UnixMilli(), Gpus: []Gpu{}}

	if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
		s.CpuUtilPct = pcts[0]
	}

	if vm, err := mem.VirtualMemory(); err == nil {
		s.RamTotalBytes = vm.Total
		s.RamUsedBytes = vm.Used
		s.RamUsedPct = vm.UsedPercent
	}

	if gpus, err := readNvidiaSmi(); err == nil {
		s.Gpus = gpus
		s.HasGpuDriver = true
		s.GpuVendor = "nvidia"
	} else {
		// Could plug in rocm-smi (AMD) and Apple Silicon (powermetrics)
		// readers here in a later phase; for Phase 5 we just flag the
		// absence and let the UI show a friendly message.
		s.HasGpuDriver = false
	}

	return s
}

// readNvidiaSmi shells out to nvidia-smi and parses the CSV output.
// Returns an error if the binary isn't on PATH (most NVIDIA installs
// drop it there automatically).
func readNvidiaSmi() ([]Gpu, error) {
	cmd := exec.Command("nvidia-smi",
		"--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu",
		"--format=csv,noheader,nounits")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	r := csv.NewReader(strings.NewReader(string(out)))
	r.TrimLeadingSpace = true
	rows, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errors.New("nvidia-smi returned no rows")
	}
	gpus := make([]Gpu, 0, len(rows))
	for _, row := range rows {
		if len(row) < 7 {
			continue
		}
		idx := atoi(row[0])
		gpus = append(gpus, Gpu{
			Index:       idx,
			Name:        strings.TrimSpace(row[1]),
			VramTotalMB: atoi(row[2]),
			VramUsedMB:  atoi(row[3]),
			VramFreeMB:  atoi(row[4]),
			UtilPct:     atoi(row[5]),
			TempC:       atoi(row[6]),
		})
	}
	return gpus, nil
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}
