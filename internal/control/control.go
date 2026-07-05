// Package control is the request/response + streaming protocol the desktop
// (Client) speaks to a remote agent (Server) over an already-secure channel —
// a relay.SecureLink in production (docs/plan-target-aware-deploy.md §4). It's
// transport-agnostic: any Conn with ordered, framed Send/Recv works.
//
// Each request gets a stream of zero-or-more `event` frames (progress) followed
// by exactly one terminal — `res` (with an optional result) or `err`. Requests
// are multiplexed by id, so many can be in flight at once (e.g. metrics polling
// while a model pulls).
package control

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
)

// Conn is the secure, ordered, framed transport. relay.SecureLink satisfies it.
type Conn interface {
	Send(frame []byte) error
	Recv() ([]byte, error)
	Close() error
}

type frame struct {
	ID     uint64          `json:"id"`
	Kind   string          `json:"kind"` // req | event | res | err
	Method string          `json:"method,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
	Error  string          `json:"error,omitempty"`
}

var errConnClosed = errors.New("control: connection closed")

// ─── Client (desktop side) ──────────────────────────────────────────────────

// Client issues control requests over a Conn.
type Client struct {
	conn Conn

	mu      sync.Mutex
	nextID  uint64
	pending map[uint64]chan frame
	closed  bool
}

// NewClient starts a Client and its read loop. Close the Conn to stop it.
func NewClient(conn Conn) *Client {
	c := &Client{conn: conn, pending: make(map[uint64]chan frame)}
	go c.readLoop()
	return c
}

// Call sends a request and unmarshals the single result into `result` (may be
// nil). Any progress events are ignored.
func (c *Client) Call(ctx context.Context, method string, params, result any) error {
	data, err := c.do(ctx, method, params, nil)
	if err != nil {
		return err
	}
	if result != nil && len(data) > 0 {
		return json.Unmarshal(data, result)
	}
	return nil
}

// Stream sends a request and invokes onEvent for each progress event until the
// terminal result (nil error) or an error.
func (c *Client) Stream(ctx context.Context, method string, params any, onEvent func(json.RawMessage) error) error {
	_, err := c.do(ctx, method, params, onEvent)
	return err
}

func (c *Client) do(ctx context.Context, method string, params any, onEvent func(json.RawMessage) error) (json.RawMessage, error) {
	pb, err := marshal(params)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errConnClosed
	}
	id := c.nextID
	c.nextID++
	ch := make(chan frame, 16)
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	if err := c.send(frame{ID: id, Kind: "req", Method: method, Data: pb}); err != nil {
		return nil, err
	}
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case f, ok := <-ch:
			if !ok {
				return nil, errConnClosed
			}
			switch f.Kind {
			case "event":
				if onEvent != nil {
					if err := onEvent(f.Data); err != nil {
						return nil, err
					}
				}
			case "res":
				return f.Data, nil
			case "err":
				return nil, errors.New(f.Error)
			}
		}
	}
}

func (c *Client) send(f frame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return c.conn.Send(b)
}

func (c *Client) readLoop() {
	for {
		data, err := c.conn.Recv()
		if err != nil {
			c.closeAll()
			return
		}
		var f frame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		c.mu.Lock()
		ch := c.pending[f.ID]
		c.mu.Unlock()
		if ch != nil {
			ch <- f
		}
	}
}

func (c *Client) closeAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
}

// ─── Server (agent side) ────────────────────────────────────────────────────

// Emit sends a progress event for the in-flight request.
type Emit func(event any) error

// Handler processes one request. It may call emit any number of times, then
// return a result (marshaled into the terminal `res`) or an error.
type Handler func(ctx context.Context, method string, params json.RawMessage, emit Emit) (result any, err error)

// Serve reads requests off conn and dispatches each to h (concurrently), until
// the conn closes. Writes are serialized by conn (Conn implementations must be
// safe for concurrent Send — relay.SecureLink is).
func Serve(ctx context.Context, conn Conn, h Handler) error {
	for {
		data, err := conn.Recv()
		if err != nil {
			return err
		}
		var f frame
		if json.Unmarshal(data, &f) != nil || f.Kind != "req" {
			continue
		}
		go serveOne(ctx, conn, h, f)
	}
}

func serveOne(ctx context.Context, conn Conn, h Handler, req frame) {
	emit := func(event any) error {
		eb, err := marshal(event)
		if err != nil {
			return err
		}
		return sendFrame(conn, frame{ID: req.ID, Kind: "event", Data: eb})
	}
	result, err := h(ctx, req.Method, req.Data, emit)
	if err != nil {
		_ = sendFrame(conn, frame{ID: req.ID, Kind: "err", Error: err.Error()})
		return
	}
	rb, mErr := marshal(result)
	if mErr != nil {
		_ = sendFrame(conn, frame{ID: req.ID, Kind: "err", Error: mErr.Error()})
		return
	}
	_ = sendFrame(conn, frame{ID: req.ID, Kind: "res", Data: rb})
}

func sendFrame(conn Conn, f frame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return conn.Send(b)
}

func marshal(v any) (json.RawMessage, error) {
	if v == nil {
		return nil, nil
	}
	return json.Marshal(v)
}
