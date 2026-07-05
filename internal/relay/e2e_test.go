package relay

import (
	"bytes"
	"fmt"
	"io"
	"sync"
	"testing"
)

// memConn is one end of an in-memory frameConn pair.
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
	ab := make(chan []byte, 16)
	ba := make(chan []byte, 16)
	return &memConn{in: ba, out: ab}, &memConn{in: ab, out: ba}
}

// tapConn records every frame written through it (to inspect what the relay
// would see on the wire).
type tapConn struct {
	inner frameConn
	mu    sync.Mutex
	sent  [][]byte
}

func (t *tapConn) Send(b []byte) error {
	t.mu.Lock()
	t.sent = append(t.sent, append([]byte(nil), b...))
	t.mu.Unlock()
	return t.inner.Send(b)
}
func (t *tapConn) Recv() ([]byte, error) { return t.inner.Recv() }
func (t *tapConn) Close() error          { return t.inner.Close() }

// run the handshake on both ends concurrently.
func runHandshake(hostFC, guestFC frameConn, hostSecret, guestSecret []byte) (*SecureLink, *SecureLink, error, error) {
	var hs, gs *SecureLink
	var he, ge error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); hs, he = handshake(hostFC, hostSecret, true) }()
	go func() { defer wg.Done(); gs, ge = handshake(guestFC, guestSecret, false) }()
	wg.Wait()
	return hs, gs, he, ge
}

func TestE2EHandshakeAndRoundTrip(t *testing.T) {
	secret, _ := GenerateSecret()
	hc, gc := memPair()
	host, guest, he, ge := runHandshake(hc, gc, secret, secret)
	if he != nil || ge != nil {
		t.Fatalf("handshake failed: host=%v guest=%v", he, ge)
	}

	if err := host.Send([]byte("run: install-runtime")); err != nil {
		t.Fatal(err)
	}
	if got, err := guest.Recv(); err != nil || string(got) != "run: install-runtime" {
		t.Fatalf("guest recv = %q, %v", got, err)
	}
	if err := guest.Send([]byte("ok: gpu=rtx4090")); err != nil {
		t.Fatal(err)
	}
	if got, err := host.Recv(); err != nil || string(got) != "ok: gpu=rtx4090" {
		t.Fatalf("host recv = %q, %v", got, err)
	}
}

func TestE2EWrongSecretIsRejected(t *testing.T) {
	s1, _ := GenerateSecret()
	s2, _ := GenerateSecret()
	hc, gc := memPair()
	_, _, he, ge := runHandshake(hc, gc, s1, s2)
	if he == nil && ge == nil {
		t.Fatal("mismatched secrets must fail key confirmation")
	}
}

// The relay only ever sees ciphertext — the plaintext must never appear in any
// frame put on the wire.
func TestE2ERelaySeesOnlyCiphertext(t *testing.T) {
	secret, _ := GenerateSecret()
	hcInner, gc := memPair()
	tap := &tapConn{inner: hcInner}
	host, guest, he, ge := runHandshake(tap, gc, secret, secret)
	if he != nil || ge != nil {
		t.Fatalf("handshake failed: host=%v guest=%v", he, ge)
	}

	marker := []byte("TOPSECRET-PLAINTEXT-MARKER-9931")
	if err := host.Send(marker); err != nil {
		t.Fatal(err)
	}
	if got, _ := guest.Recv(); string(got) != string(marker) {
		t.Fatalf("guest decrypt mismatch: %q", got)
	}

	tap.mu.Lock()
	defer tap.mu.Unlock()
	for i, frame := range tap.sent {
		if bytes.Contains(frame, marker) {
			t.Fatalf("plaintext marker leaked in on-the-wire frame %d", i)
		}
	}
}

// Concurrent Send must not corrupt the nonce sequence — every frame decrypts.
func TestE2EConcurrentSends(t *testing.T) {
	secret, _ := GenerateSecret()
	hc, gc := memPair()
	host, guest, he, ge := runHandshake(hc, gc, secret, secret)
	if he != nil || ge != nil {
		t.Fatalf("handshake: host=%v guest=%v", he, ge)
	}

	const n = 50
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); _ = host.Send([]byte(fmt.Sprintf("msg-%d", i))) }(i)
	}
	seen := make(map[string]bool, n)
	for i := 0; i < n; i++ {
		got, err := guest.Recv()
		if err != nil {
			t.Fatalf("recv %d: %v", i, err)
		}
		seen[string(got)] = true
	}
	wg.Wait()
	if len(seen) != n {
		t.Fatalf("got %d distinct messages, want %d", len(seen), n)
	}
}

func TestEnrollCodeSplitsRoutingFromSecret(t *testing.T) {
	code, secret, err := EnrollCode("K7QF3ZB2")
	if err != nil {
		t.Fatal(err)
	}
	// The relay-visible routing part must NOT contain the secret.
	if got := code[:8]; got != "K7QF3ZB2" {
		t.Fatalf("routing prefix = %q", got)
	}
	pid, sec, err := ParseEnrollCode(code)
	if err != nil {
		t.Fatal(err)
	}
	if pid != "K7QF3ZB2" || !bytes.Equal(sec, secret) {
		t.Fatalf("round-trip mismatch: pid=%q secretEq=%v", pid, bytes.Equal(sec, secret))
	}
}

func TestParseEnrollCodeRejectsGarbage(t *testing.T) {
	for _, bad := range []string{"", "nodash", "PID-", "-SECRET", "PID-!!!"} {
		if _, _, err := ParseEnrollCode(bad); err == nil {
			t.Fatalf("ParseEnrollCode(%q) should have errored", bad)
		}
	}
}
