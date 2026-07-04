package relay

// WebSocket transport for the relay. A connecting party sends one control
// frame (TextMessage JSON) to declare its role — {"op":"register"} or
// {"op":"join","code":"..."} — then, once paired, both sides exchange opaque
// BinaryMessages the relay forwards verbatim. Mount NewServer at a path on
// your http.Server (see cmd/blueprint-relay).

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var (
	errPeerClosed = errors.New("relay: peer connection closed")
	errPeerSlow   = errors.New("relay: peer send buffer full")
)

// ctrl is a handshake control frame (WS TextMessage).
type ctrl struct {
	Op    string `json:"op"`              // register | registered | join | joined | paired | error
	Code  string `json:"code,omitempty"`  // register→code, join→code
	Error string `json:"error,omitempty"` // error detail
}

// Server upgrades WebSocket connections and drives the relay handshake +
// forwarding. Implements http.Handler.
type Server struct {
	relay      *Relay
	upgrader   websocket.Upgrader
	writeWait  time.Duration
	sendBuffer int
}

// NewServer wraps a Relay in a WebSocket http.Handler.
func NewServer(r *Relay) *Server {
	return &Server{
		relay: r,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			// The relay is dialed by native Go clients, not browsers — there's
			// no cross-origin browser threat model. TLS + the join-code
			// handshake + E2E encryption are the real access controls.
			CheckOrigin: func(*http.Request) bool { return true },
		},
		writeWait:  10 * time.Second,
		sendBuffer: 64,
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	conn, err := s.upgrader.Upgrade(w, req, nil)
	if err != nil {
		return // upgrader already responded
	}
	p := newPeer(conn, s.sendBuffer, s.writeWait)
	go p.writePump()
	defer p.close()

	c, err := p.readControl()
	if err != nil {
		return
	}
	switch c.Op {
	case "register":
		s.handleHost(p)
	case "join":
		s.handleGuest(p, c.Code)
	default:
		p.sendControl(ctrl{Op: "error", Error: "expected register or join"})
	}
}

func (s *Server) handleHost(p *peer) {
	reg, err := s.relay.Register(p)
	if err != nil {
		p.sendControl(ctrl{Op: "error", Error: "relay unavailable"})
		return
	}
	p.sendControl(ctrl{Op: "registered", Code: reg.Code})

	var sess *Session
	select {
	case sess = <-reg.Paired():
	case <-time.After(DefaultCodeTTL):
		s.relay.Cancel(reg.Code)
		p.sendControl(ctrl{Op: "error", Error: "join code expired"})
		return
	}
	p.sendControl(ctrl{Op: "paired"})
	p.forwardLoop(sess.FromHost)
}

func (s *Server) handleGuest(p *peer, code string) {
	sess, err := s.relay.Join(code, p)
	if err != nil {
		p.sendControl(ctrl{Op: "error", Error: err.Error()})
		return
	}
	p.sendControl(ctrl{Op: "joined"})
	p.forwardLoop(sess.FromGuest)
}

// ─── peer: one WS connection, single-writer via a send channel ──────────────

type outFrame struct {
	typ  int
	data []byte
}

// peer is one party's WebSocket connection. It implements relay.Sink: forwarded
// frames are queued on `send` and written by the single writePump goroutine, so
// the connection has exactly one writer (gorilla requires this).
type peer struct {
	conn      *websocket.Conn
	send      chan outFrame
	done      chan struct{}
	writeWait time.Duration
	closeOnce sync.Once
}

func newPeer(conn *websocket.Conn, buf int, writeWait time.Duration) *peer {
	return &peer{
		conn:      conn,
		send:      make(chan outFrame, buf),
		done:      make(chan struct{}),
		writeWait: writeWait,
	}
}

// Deliver implements relay.Sink — frames forwarded to this party. Non-blocking:
// a peer whose buffer is full is dropped rather than wedging the sender.
func (p *peer) Deliver(frame []byte) error {
	f := outFrame{typ: websocket.BinaryMessage, data: append([]byte(nil), frame...)}
	select {
	case p.send <- f:
		return nil
	case <-p.done:
		return errPeerClosed
	default:
		p.close()
		return errPeerSlow
	}
}

func (p *peer) sendControl(c ctrl) {
	b, _ := json.Marshal(c)
	select {
	case p.send <- outFrame{typ: websocket.TextMessage, data: b}:
	case <-p.done:
	}
}

func (p *peer) writePump() {
	for {
		select {
		case f := <-p.send:
			_ = p.conn.SetWriteDeadline(time.Now().Add(p.writeWait))
			if err := p.conn.WriteMessage(f.typ, f.data); err != nil {
				p.close()
				return
			}
		case <-p.done:
			return
		}
	}
}

func (p *peer) readControl() (ctrl, error) {
	for {
		typ, data, err := p.conn.ReadMessage()
		if err != nil {
			return ctrl{}, err
		}
		if typ != websocket.TextMessage {
			continue
		}
		var c ctrl
		if err := json.Unmarshal(data, &c); err != nil {
			return ctrl{}, err
		}
		return c, nil
	}
}

// forwardLoop reads binary frames from this conn and hands each to fwd (which
// delivers to the peer). Returns when the conn closes or fwd errors.
func (p *peer) forwardLoop(fwd func([]byte) error) {
	for {
		typ, data, err := p.conn.ReadMessage()
		if err != nil {
			return
		}
		if typ != websocket.BinaryMessage {
			continue
		}
		if err := fwd(data); err != nil {
			return
		}
	}
}

func (p *peer) close() {
	p.closeOnce.Do(func() {
		close(p.done)
		_ = p.conn.Close()
	})
}
