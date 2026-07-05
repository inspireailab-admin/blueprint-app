package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// in-memory Conn pair.
type memConn struct {
	in  <-chan []byte
	out chan<- []byte
}

func (m *memConn) Send(b []byte) error { m.out <- append([]byte(nil), b...); return nil }
func (m *memConn) Recv() ([]byte, error) {
	b, ok := <-m.in
	if !ok {
		return nil, io.EOF
	}
	return b, nil
}
func (m *memConn) Close() error { return nil }

func memPair() (*memConn, *memConn) {
	ab := make(chan []byte, 64)
	ba := make(chan []byte, 64)
	return &memConn{in: ba, out: ab}, &memConn{in: ab, out: ba}
}

// stub agent handler.
func stub(_ context.Context, method string, params json.RawMessage, emit Emit) (any, error) {
	switch method {
	case "ping":
		return map[string]string{"reply": "pong"}, nil
	case "echo":
		var s string
		_ = json.Unmarshal(params, &s)
		return s, nil
	case "pull":
		for i := 1; i <= 3; i++ {
			if err := emit(map[string]int{"pct": i * 33}); err != nil {
				return nil, err
			}
		}
		return map[string]string{"status": "done"}, nil
	case "boom":
		return nil, errors.New("kaboom")
	default:
		return nil, fmt.Errorf("unknown method %q", method)
	}
}

func setup(t *testing.T) (*Client, context.Context, func()) {
	t.Helper()
	a, b := memPair()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = Serve(ctx, b, stub) }()
	c := NewClient(a)
	return c, ctx, func() { cancel(); _ = a.Close(); _ = b.Close() }
}

func TestCallReturnsResult(t *testing.T) {
	c, ctx, done := setup(t)
	defer done()
	var r map[string]string
	if err := c.Call(ctx, "ping", nil, &r); err != nil {
		t.Fatal(err)
	}
	if r["reply"] != "pong" {
		t.Fatalf("got %v", r)
	}
}

func TestStreamDeliversEventsThenResult(t *testing.T) {
	c, ctx, done := setup(t)
	defer done()
	var pcts []int
	err := c.Stream(ctx, "pull", nil, func(d json.RawMessage) error {
		var e struct{ Pct int }
		_ = json.Unmarshal(d, &e)
		pcts = append(pcts, e.Pct)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(pcts) != "[33 66 99]" {
		t.Fatalf("events = %v, want [33 66 99]", pcts)
	}
}

func TestErrorPropagates(t *testing.T) {
	c, ctx, done := setup(t)
	defer done()
	err := c.Call(ctx, "boom", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "kaboom") {
		t.Fatalf("err = %v, want kaboom", err)
	}
}

func TestUnknownMethod(t *testing.T) {
	c, ctx, done := setup(t)
	defer done()
	if err := c.Call(ctx, "nope", nil, nil); err == nil {
		t.Fatal("unknown method should error")
	}
}

// Many concurrent calls are multiplexed by id — each gets its own response.
func TestConcurrentCallsAreMultiplexed(t *testing.T) {
	c, ctx, done := setup(t)
	defer done()
	const n = 30
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			want := fmt.Sprintf("v%d", i)
			var got string
			if err := c.Call(ctx, "echo", want, &got); err != nil {
				errs <- err
				return
			}
			if got != want {
				errs <- fmt.Errorf("echo %d: got %q", i, got)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

func TestCallRespectsContext(t *testing.T) {
	c, _, done := setup(t)
	defer done()
	// "slow" isn't handled → the server errors "unknown method", but use a
	// cancelled context to exercise the ctx path deterministically.
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	time.Sleep(time.Millisecond)
	if err := c.Call(ctx, "ping", nil, nil); err == nil {
		t.Fatal("expected context error")
	}
}
