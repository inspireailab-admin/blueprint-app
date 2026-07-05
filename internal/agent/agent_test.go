package agent

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/relay"
)

type stubRuntime struct {
	mu     sync.Mutex
	served ServeSpec
}

func (s *stubRuntime) DetectHardware(context.Context) (Hardware, error) {
	return Hardware{
		OS: "Ubuntu 24.04", CPUCores: 16, RAMTotalGB: 64, RAMFreeGB: 60,
		GPUs: []GPU{{Index: 0, Name: "RTX 4090", Vendor: "nvidia", VRAMTotalMB: 24564, VRAMFreeMB: 24000}},
	}, nil
}
func (s *stubRuntime) InstallRuntime(_ context.Context, emit func(Progress)) error {
	emit(Progress{Stage: "download", Pct: 50})
	emit(Progress{Stage: "done", Pct: 100})
	return nil
}
func (s *stubRuntime) PullModel(_ context.Context, modelID, _ string, emit func(Progress)) error {
	if modelID == "" {
		return errors.New("missing model")
	}
	for _, p := range []int{25, 50, 75, 100} {
		emit(Progress{Stage: "pull", Pct: p})
	}
	return nil
}
func (s *stubRuntime) Serve(_ context.Context, spec ServeSpec) (ServeStatus, error) {
	s.mu.Lock()
	s.served = spec
	s.mu.Unlock()
	return ServeStatus{State: "running", Endpoint: "http://127.0.0.1:8080/v1", PID: 4242}, nil
}
func (s *stubRuntime) Stop(context.Context) error                  { return nil }
func (s *stubRuntime) Status(context.Context) (ServeStatus, error) { return ServeStatus{State: "running"}, nil }
func (s *stubRuntime) Metrics(context.Context) (Metrics, error) {
	return Metrics{TokPerSec: 87.5, ActiveSlots: 2, TTFTms: 120, UptimeSec: 3600}, nil
}

// Full stack: relay + E2E + control + agent. The desktop enrolls a stub agent
// and drives it through the whole flow.
func TestAgentEnrollAndDriveOverRelay(t *testing.T) {
	srv := httptest.NewServer(relay.NewServer(relay.New()))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	code, wait, err := Enroll(ctx, wsURL)
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}

	rt := &stubRuntime{}
	go func() { _ = Run(ctx, wsURL, code, rt) }()

	dc, err := wait()
	if err != nil {
		t.Fatalf("host wait: %v", err)
	}

	hw, err := dc.DetectHardware(ctx)
	if err != nil {
		t.Fatalf("detect: %v", err)
	}
	if len(hw.GPUs) != 1 || hw.GPUs[0].Name != "RTX 4090" {
		t.Fatalf("hardware = %+v", hw)
	}

	var pulls []int
	if err := dc.PullModel(ctx, "qwen-2.5-7b", "q4", func(p Progress) { pulls = append(pulls, p.Pct) }); err != nil {
		t.Fatalf("pull: %v", err)
	}
	if len(pulls) != 4 || pulls[3] != 100 {
		t.Fatalf("pull progress = %v", pulls)
	}

	st, err := dc.Serve(ctx, ServeSpec{ModelID: "qwen-2.5-7b", Quant: "q4", CtxSize: 4096, NGpuLayers: 999})
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if st.State != "running" || st.PID != 4242 {
		t.Fatalf("serve status = %+v", st)
	}
	rt.mu.Lock()
	gotModel := rt.served.ModelID
	rt.mu.Unlock()
	if gotModel != "qwen-2.5-7b" {
		t.Fatalf("agent served model = %q", gotModel)
	}

	m, err := dc.Metrics(ctx)
	if err != nil {
		t.Fatalf("metrics: %v", err)
	}
	if m.TokPerSec != 87.5 || m.ActiveSlots != 2 {
		t.Fatalf("metrics = %+v", m)
	}
}

func TestAgentPropagatesRuntimeError(t *testing.T) {
	srv := httptest.NewServer(relay.NewServer(relay.New()))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	pairID, wait, _ := relay.RegisterAsHost(ctx, wsURL)
	code, secret, _ := relay.EnrollCode(pairID)
	go func() { _ = Run(ctx, wsURL, code, &stubRuntime{}) }()

	hl, _ := wait()
	hsec, _ := relay.SecureAsHost(hl, secret)
	dc := NewDesktopClient(hsec)

	// empty model id → the stub returns an error, which must surface.
	if err := dc.PullModel(ctx, "", "q4", func(Progress) {}); err == nil {
		t.Fatal("expected runtime error to propagate")
	}
}
