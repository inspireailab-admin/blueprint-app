package relay

// Client helpers for the two roles. The desktop uses RegisterAsHost (show the
// join code, wait for the agent). The agent uses JoinAsGuest (paste the code).
// Both return a *Link — a paired, full-duplex channel of opaque frames. The
// caller layers end-to-end encryption on top; the relay never sees plaintext.

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/gorilla/websocket"
)

// Link is a paired connection to the peer through the relay.
type Link struct {
	conn *websocket.Conn
	wmu  sync.Mutex // gorilla allows one concurrent writer
}

// Send delivers one frame to the peer.
func (l *Link) Send(frame []byte) error {
	l.wmu.Lock()
	defer l.wmu.Unlock()
	return l.conn.WriteMessage(websocket.BinaryMessage, frame)
}

// Recv blocks for the next frame from the peer.
func (l *Link) Recv() ([]byte, error) {
	for {
		typ, data, err := l.conn.ReadMessage()
		if err != nil {
			return nil, err
		}
		if typ == websocket.BinaryMessage {
			return data, nil
		}
	}
}

// Close tears down the link.
func (l *Link) Close() error { return l.conn.Close() }

// RegisterAsHost dials the relay, registers, and returns the single-use join
// code plus a wait function that blocks until a guest pairs, yielding the Link.
func RegisterAsHost(ctx context.Context, url string) (code string, wait func() (*Link, error), err error) {
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, url, nil)
	if err != nil {
		return "", nil, err
	}
	if err := writeCtrl(conn, ctrl{Op: "register"}); err != nil {
		conn.Close()
		return "", nil, err
	}
	c, err := readCtrl(conn)
	if err != nil {
		conn.Close()
		return "", nil, err
	}
	if c.Op != "registered" {
		conn.Close()
		return "", nil, relayError(c)
	}
	wait = func() (*Link, error) {
		c, err := readCtrl(conn)
		if err != nil {
			conn.Close()
			return nil, err
		}
		if c.Op != "paired" {
			conn.Close()
			return nil, relayError(c)
		}
		return &Link{conn: conn}, nil
	}
	return c.Code, wait, nil
}

// JoinAsGuest dials the relay, joins with the code, and returns the paired Link.
func JoinAsGuest(ctx context.Context, url, code string) (*Link, error) {
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	if err := writeCtrl(conn, ctrl{Op: "join", Code: code}); err != nil {
		conn.Close()
		return nil, err
	}
	c, err := readCtrl(conn)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if c.Op != "joined" {
		conn.Close()
		return nil, relayError(c)
	}
	return &Link{conn: conn}, nil
}

func writeCtrl(conn *websocket.Conn, c ctrl) error {
	b, _ := json.Marshal(c)
	return conn.WriteMessage(websocket.TextMessage, b)
}

func readCtrl(conn *websocket.Conn) (ctrl, error) {
	for {
		typ, data, err := conn.ReadMessage()
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

func relayError(c ctrl) error {
	if c.Error != "" {
		return fmt.Errorf("relay: %s", c.Error)
	}
	return fmt.Errorf("relay: unexpected response %q", c.Op)
}
