package relay

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// End-to-end over a real WebSocket loopback: a desktop-client and an
// agent-client pair through the relay and exchange frames both ways — the
// same path the desktop and agent will use, minus TLS.
func TestWebSocketRelayEndToEnd(t *testing.T) {
	srv := httptest.NewServer(NewServer(New()))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") // http(s)→ws(s)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	code, wait, err := RegisterAsHost(ctx, wsURL)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if len(code) != 8 {
		t.Fatalf("join code %q", code)
	}

	type joinRes struct {
		link *Link
		err  error
	}
	joined := make(chan joinRes, 1)
	go func() {
		gl, err := JoinAsGuest(ctx, wsURL, code)
		joined <- joinRes{gl, err}
	}()

	hostLink, err := wait() // blocks until the guest pairs
	if err != nil {
		t.Fatalf("host wait: %v", err)
	}
	defer hostLink.Close()

	jr := <-joined
	if jr.err != nil {
		t.Fatalf("guest join: %v", jr.err)
	}
	guestLink := jr.link
	defer guestLink.Close()

	// host → guest
	if err := hostLink.Send([]byte("ping-agent")); err != nil {
		t.Fatalf("host send: %v", err)
	}
	if got, err := guestLink.Recv(); err != nil || string(got) != "ping-agent" {
		t.Fatalf("guest recv = %q, %v; want ping-agent", got, err)
	}

	// guest → host
	if err := guestLink.Send([]byte("pong-desktop")); err != nil {
		t.Fatalf("guest send: %v", err)
	}
	if got, err := hostLink.Recv(); err != nil || string(got) != "pong-desktop" {
		t.Fatalf("host recv = %q, %v; want pong-desktop", got, err)
	}
}

func TestWebSocketJoinBadCodeFails(t *testing.T) {
	srv := httptest.NewServer(NewServer(New()))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := JoinAsGuest(ctx, wsURL, "BADCODE1"); err == nil {
		t.Fatal("join with an unknown code should fail")
	}
}
