// Package agentruntime implements agent.Runtime against this machine's real
// blueprint-svc operations. A paired desktop drives it over the E2E control
// channel: detect hardware, install llama.cpp, pull weights, serve, monitor.
//
// Serve/Stop work through svcconfig (the same on-disk contract the supervisor
// reads), so the already-running supervisor spawns/kills llama-server — the
// adapter just writes desired state.
package agentruntime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/agent"
	"github.com/inspireailab-admin/blueprint-app/internal/hwdetect"
	"github.com/inspireailab-admin/blueprint-app/internal/llamametrics"
	"github.com/inspireailab-admin/blueprint-app/internal/svcconfig"
	"github.com/inspireailab-admin/blueprint-cli/pkg/catalog"
	"github.com/inspireailab-admin/blueprint-cli/pkg/download"
	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"
	"github.com/inspireailab-admin/blueprint-cli/pkg/runtime"
)

// Runtime is the production agent.Runtime for a Blueprint-managed machine.
type Runtime struct{}

var _ agent.Runtime = Runtime{}

func (Runtime) DetectHardware(ctx context.Context) (agent.Hardware, error) {
	s := hwdetect.Detect(ctx)
	hw := agent.Hardware{
		OS: s.OS, CPUCores: s.CPUCores,
		RAMTotalGB: s.RAMTotalGB, RAMFreeGB: s.RAMFreeGB,
	}
	for _, g := range s.GPUs {
		hw.GPUs = append(hw.GPUs, agent.GPU{
			Index: g.Index, Name: g.Name, Vendor: g.Vendor,
			VRAMTotalMB: g.VRAMTotalMB, VRAMFreeMB: g.VRAMFreeMB,
		})
	}
	return hw, nil
}

func (Runtime) InstallRuntime(ctx context.Context, emit func(agent.Progress)) error {
	return runtime.InstallWithOptions(ctx, runtime.InstallOptions{
		OnStage: func(stage, detail string) {
			emit(agent.Progress{Stage: stage, Detail: detail})
		},
		OnProgress: func(p download.Progress) {
			emit(agent.Progress{Stage: "downloading", Pct: pct(p.BytesDownloaded, p.BytesTotal)})
		},
	})
}

func (Runtime) PullModel(ctx context.Context, modelID, quant string, emit func(agent.Progress)) error {
	model, err := catalog.Get(modelID)
	if err != nil {
		return err
	}
	url, fileName, err := model.DownloadURL(quant)
	if err != nil {
		return err
	}
	dst, err := paths.ModelFile(modelID, fileName)
	if err != nil {
		return err
	}
	if fi, err := os.Stat(dst); err == nil && fi.Size() > 0 {
		emit(agent.Progress{Stage: "present", Pct: 100})
		return nil
	}
	return download.FileWithOptions(ctx, url, dst, download.Options{
		OnProgress: func(p download.Progress) {
			emit(agent.Progress{Stage: "pull", Pct: pct(p.BytesDownloaded, p.BytesTotal)})
		},
	})
}

func (Runtime) Serve(_ context.Context, spec agent.ServeSpec) (agent.ServeStatus, error) {
	bin, err := runtime.Find()
	if err != nil {
		return agent.ServeStatus{}, fmt.Errorf("runtime not installed: %w", err)
	}
	model, err := catalog.Get(spec.ModelID)
	if err != nil {
		return agent.ServeStatus{}, err
	}
	fileName, ok := model.QuantFiles()[spec.Quant]
	if !ok {
		return agent.ServeStatus{}, fmt.Errorf("model %s has no %s GGUF", spec.ModelID, spec.Quant)
	}
	modelPath, err := paths.ModelFile(spec.ModelID, fileName)
	if err != nil {
		return agent.ServeStatus{}, err
	}
	if _, err := os.Stat(modelPath); err != nil {
		return agent.ServeStatus{}, fmt.Errorf("model not on disk — pull it first: %s", modelPath)
	}

	// Preserve an existing API key so a re-serve doesn't invalidate clients.
	apiKey := randKey()
	if cur, _ := svcconfig.ReadConfig(); cur != nil && cur.APIKey != "" {
		apiKey = cur.APIKey
	}
	ctxSize := spec.CtxSize
	if ctxSize <= 0 {
		ctxSize = 4096
	}
	ngl := spec.NGpuLayers
	if ngl < 0 {
		ngl = 999
	}

	const port = 8080
	cfg := svcconfig.Config{
		LlamaServerBin: bin,
		ModelPath:      modelPath,
		ModelID:        spec.ModelID,
		Quant:          spec.Quant,
		BindHost:       "127.0.0.1",
		Port:           port,
		APIKey:         apiKey,
		CtxSize:        ctxSize,
		NGpuLayers:     ngl,
		EnableMetrics:  true,
		SplitMode:      spec.SplitMode,
		TensorSplit:    spec.TensorSplit,
		UpdatedAt:      time.Now().UnixMilli(),
	}
	if err := svcconfig.WriteConfig(cfg); err != nil {
		return agent.ServeStatus{}, err
	}
	// The supervisor picks up the config and spawns llama-server within ~5s.
	return agent.ServeStatus{
		State:    "starting",
		Endpoint: fmt.Sprintf("http://127.0.0.1:%d/v1", port),
	}, nil
}

func (Runtime) Stop(context.Context) error {
	return svcconfig.DeleteConfig()
}

func (Runtime) Status(context.Context) (agent.ServeStatus, error) {
	st, err := svcconfig.ReadStatus()
	if err != nil {
		return agent.ServeStatus{}, err
	}
	if st == nil || st.Phase == "" {
		return agent.ServeStatus{State: "stopped"}, nil
	}
	out := agent.ServeStatus{State: st.Phase, PID: st.PID}
	if st.Port > 0 {
		out.Endpoint = fmt.Sprintf("http://127.0.0.1:%d/v1", st.Port)
	}
	return out, nil
}

func (Runtime) Metrics(ctx context.Context) (agent.Metrics, error) {
	port := 8080
	apiKey := ""
	if cfg, _ := svcconfig.ReadConfig(); cfg != nil {
		if cfg.Port > 0 {
			port = cfg.Port
		}
		apiKey = cfg.APIKey
	}
	m, ok := llamametrics.Scrape(ctx, port, apiKey)
	if !ok {
		return agent.Metrics{}, nil
	}
	var up int64
	if st, _ := svcconfig.ReadStatus(); st != nil && st.StartedAtMs > 0 {
		up = (time.Now().UnixMilli() - st.StartedAtMs) / 1000
	}
	return agent.Metrics{
		TokPerSec:   m.TokensPerSecond,
		ActiveSlots: int(m.RequestsProcessing),
		UptimeSec:   up,
	}, nil
}

func pct(done, total int64) int {
	if total <= 0 {
		return 0
	}
	return int(done * 100 / total)
}

func randKey() string {
	var b [24]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
