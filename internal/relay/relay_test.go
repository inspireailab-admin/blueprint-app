package relay

import (
	"testing"
	"time"
)

// memSink captures delivered frames for assertions.
type memSink struct{ got [][]byte }

func (m *memSink) Deliver(f []byte) error {
	// Copy — a real transport must not alias the relay's buffer.
	cp := append([]byte(nil), f...)
	m.got = append(m.got, cp)
	return nil
}

func TestPairAndForwardBothWays(t *testing.T) {
	r := New()
	host, guest := &memSink{}, &memSink{}

	reg, err := r.Register(host)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	sess, err := r.Join(reg.Code, guest)
	if err != nil {
		t.Fatalf("join: %v", err)
	}

	// The host learns the same session via its Paired channel.
	select {
	case hs := <-reg.Paired():
		if hs != sess {
			t.Fatal("host paired with a different session than the guest")
		}
	case <-time.After(time.Second):
		t.Fatal("host never notified of pairing")
	}

	if err := sess.FromHost([]byte("hello-agent")); err != nil {
		t.Fatal(err)
	}
	if err := sess.FromGuest([]byte("hello-desktop")); err != nil {
		t.Fatal(err)
	}

	if len(guest.got) != 1 || string(guest.got[0]) != "hello-agent" {
		t.Fatalf("guest inbox = %q, want [hello-agent]", guest.got)
	}
	if len(host.got) != 1 || string(host.got[0]) != "hello-desktop" {
		t.Fatalf("host inbox = %q, want [hello-desktop]", host.got)
	}
}

func TestUnknownCodeRejected(t *testing.T) {
	r := New()
	if _, err := r.Join("NOTACODE", &memSink{}); err != ErrUnknownCode {
		t.Fatalf("join(unknown) err = %v, want ErrUnknownCode", err)
	}
}

func TestCodeIsSingleUse(t *testing.T) {
	r := New()
	reg, _ := r.Register(&memSink{})
	if _, err := r.Join(reg.Code, &memSink{}); err != nil {
		t.Fatalf("first join: %v", err)
	}
	if _, err := r.Join(reg.Code, &memSink{}); err != ErrUnknownCode {
		t.Fatalf("reused code err = %v, want ErrUnknownCode", err)
	}
}

func TestCodeExpires(t *testing.T) {
	r := New()
	now := time.Unix(1_000_000, 0)
	r.now = func() time.Time { return now }

	reg, _ := r.Register(&memSink{})
	now = now.Add(DefaultCodeTTL + time.Second) // past TTL
	if _, err := r.Join(reg.Code, &memSink{}); err != ErrUnknownCode {
		t.Fatalf("expired code err = %v, want ErrUnknownCode", err)
	}
	if r.Pending() != 0 {
		t.Fatalf("expired code should be gc'd, pending = %d", r.Pending())
	}
}

func TestCancelDropsPending(t *testing.T) {
	r := New()
	reg, _ := r.Register(&memSink{})
	r.Cancel(reg.Code)
	if _, err := r.Join(reg.Code, &memSink{}); err != ErrUnknownCode {
		t.Fatalf("cancelled code err = %v, want ErrUnknownCode", err)
	}
}

// The relay must forward opaque bytes verbatim — proof it's zero-knowledge
// (it neither parses nor mutates the E2E-encrypted payload).
func TestFramesForwardedVerbatim(t *testing.T) {
	r := New()
	host, guest := &memSink{}, &memSink{}
	reg, _ := r.Register(host)
	sess, _ := r.Join(reg.Code, guest)

	cipher := []byte{0x00, 0xff, 0x10, 0x00, 0x99, 0x7f}
	if err := sess.FromHost(cipher); err != nil {
		t.Fatal(err)
	}
	if len(guest.got) != 1 || string(guest.got[0]) != string(cipher) {
		t.Fatalf("relay altered the frame: got %v, want %v", guest.got, cipher)
	}
}

func TestJoinCodesAreDistinctAndSized(t *testing.T) {
	r := New()
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		reg, err := r.Register(&memSink{})
		if err != nil {
			t.Fatal(err)
		}
		if len(reg.Code) != 8 {
			t.Fatalf("code %q len = %d, want 8", reg.Code, len(reg.Code))
		}
		if seen[reg.Code] {
			t.Fatalf("duplicate join code %q", reg.Code)
		}
		seen[reg.Code] = true
	}
}
