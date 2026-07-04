// Package relay is the coordination core of Blueprint's enrollment relay
// (docs/plan-target-aware-deploy.md §5). It pairs a desktop app ("host")
// with a remote agent ("guest") via a single-use join code, then forwards
// opaque frames between them.
//
// It is ZERO-KNOWLEDGE: a frame is a []byte the relay forwards verbatim and
// never interprets, so end-to-end encryption between the two parties keeps
// their control traffic and metrics private from the relay operator. The
// transport (WebSocket-over-TLS, see server.go) is layered on top; this file
// is transport-agnostic and unit-testable in-process.
package relay

import (
	"crypto/rand"
	"encoding/base32"
	"errors"
	"sync"
	"time"
)

// ErrUnknownCode is returned when a join code is unknown, already used, or
// expired. The three cases are intentionally indistinguishable so a caller
// can't probe which codes exist.
var ErrUnknownCode = errors.New("relay: unknown or expired join code")

// DefaultCodeTTL is how long a join code stays valid after Register.
const DefaultCodeTTL = 5 * time.Minute

// Sink receives frames the relay forwards to a party. Implemented by the
// transport layer (e.g. a WebSocket write pump).
type Sink interface {
	Deliver(frame []byte) error
}

// Session is a paired host+guest link, shared by both sides' connections.
// The transport pushes inbound frames through FromHost / FromGuest.
type Session struct {
	ID    string
	host  Sink
	guest Sink
}

// FromHost forwards a frame from the host (desktop) to the guest (agent).
func (s *Session) FromHost(frame []byte) error { return s.guest.Deliver(frame) }

// FromGuest forwards a frame from the guest (agent) to the host (desktop).
func (s *Session) FromGuest(frame []byte) error { return s.host.Deliver(frame) }

// HostReg is returned by Register. The host holds its connection open and
// waits on Paired() for a guest to join with the code; both sides then share
// the delivered Session for forwarding.
type HostReg struct {
	Code   string
	paired chan *Session
}

// Paired receives exactly one Session when a guest joins with this code.
func (h *HostReg) Paired() <-chan *Session { return h.paired }

type pending struct {
	host    Sink
	paired  chan *Session
	expires time.Time
}

// Relay coordinates enrollment. Safe for concurrent use.
type Relay struct {
	mu      sync.Mutex
	pending map[string]pending // join code → waiting host

	ttl time.Duration
	now func() time.Time       // injectable clock (tests)
	gen func() (string, error) // injectable code generator (tests)
}

// New returns a Relay with production defaults.
func New() *Relay {
	return &Relay{
		pending: make(map[string]pending),
		ttl:     DefaultCodeTTL,
		now:     time.Now,
		gen:     genCode,
	}
}

// Register puts a host (desktop) in the waiting room and returns a single-use
// join code plus a channel that yields the Session once a guest joins.
func (r *Relay) Register(host Sink) (*HostReg, error) {
	code, err := r.gen()
	if err != nil {
		return nil, err
	}
	reg := &HostReg{Code: code, paired: make(chan *Session, 1)}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.gcLocked()
	r.pending[code] = pending{host: host, paired: reg.paired, expires: r.now().Add(r.ttl)}
	return reg, nil
}

// Join pairs a guest with the host that registered `code`. The code is
// single-use — consumed on success. The paired Session is both returned to
// the guest and delivered to the host's Paired() channel.
func (r *Relay) Join(code string, guest Sink) (*Session, error) {
	r.mu.Lock()
	p, ok := r.pending[code]
	if !ok || r.now().After(p.expires) {
		delete(r.pending, code)
		r.mu.Unlock()
		return nil, ErrUnknownCode
	}
	delete(r.pending, code) // single-use
	r.mu.Unlock()

	id, err := r.gen()
	if err != nil {
		return nil, err
	}
	sess := &Session{ID: id, host: p.host, guest: guest}
	p.paired <- sess // buffered(1) — never blocks
	return sess, nil
}

// Cancel drops a pending registration (host disconnected before a guest paired).
func (r *Relay) Cancel(code string) {
	r.mu.Lock()
	delete(r.pending, code)
	r.mu.Unlock()
}

// Pending reports how many unpaired codes are currently waiting (for metrics).
func (r *Relay) Pending() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.gcLocked()
	return len(r.pending)
}

// gcLocked drops expired pending codes. Caller must hold r.mu.
func (r *Relay) gcLocked() {
	now := r.now()
	for code, p := range r.pending {
		if now.After(p.expires) {
			delete(r.pending, code)
		}
	}
}

// genCode returns a short, high-entropy, human-typeable join code
// (40 bits → 8 base32 chars, no padding, e.g. "K7QF3ZB2").
func genCode() (string, error) {
	var b [5]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:]), nil
}
