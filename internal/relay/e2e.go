package relay

// End-to-end encryption layer over a paired relay Link. Makes the relay
// provably zero-knowledge: it forwards only ciphertext it can't read.
//
// The relay knows the routing code (it pairs on it), so that code can't be the
// authentication secret. The user-facing enrollment code is PAIRID-SECRET: the
// relay sees only PAIRID; the desktop-generated SECRET travels out-of-band
// (shown on screen, pasted into the agent) and is never sent to the relay. It
// authenticates an ephemeral X25519 exchange — a man-in-the-middle (even a
// malicious relay) can't derive the session key or forge the key-confirmation
// without SECRET, so tampering is detected and the handshake aborts.

import (
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"
)

const (
	enrollInfo  = "blueprint-enroll-v1"
	secretBytes = 16 // 128-bit E2E secret
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// frameConn is the opaque-frame transport the E2E layer runs over. *Link
// satisfies it; tests use an in-memory pair.
type frameConn interface {
	Send(frame []byte) error
	Recv() ([]byte, error)
	Close() error
}

// GenerateSecret returns a fresh 128-bit E2E secret.
func GenerateSecret() ([]byte, error) {
	s := make([]byte, secretBytes)
	if _, err := rand.Read(s); err != nil {
		return nil, err
	}
	return s, nil
}

// EnrollCode combines the relay routing code (pairID) with a fresh secret into
// the user-facing "PAIRID-SECRET". The relay only ever sees PAIRID.
func EnrollCode(pairID string) (code string, secret []byte, err error) {
	secret, err = GenerateSecret()
	if err != nil {
		return "", nil, err
	}
	return pairID + "-" + b32.EncodeToString(secret), secret, nil
}

// ParseEnrollCode splits "PAIRID-SECRET" into the routing pairID and the secret.
func ParseEnrollCode(code string) (pairID string, secret []byte, err error) {
	code = strings.TrimSpace(strings.ToUpper(code))
	i := strings.LastIndex(code, "-")
	if i <= 0 || i == len(code)-1 {
		return "", nil, errors.New("enroll code must be PAIRID-SECRET")
	}
	secret, err = b32.DecodeString(code[i+1:])
	if err != nil || len(secret) == 0 {
		return "", nil, errors.New("enroll code: invalid secret")
	}
	return code[:i], secret, nil
}

// SecureLink is an E2E-encrypted channel over a paired relay Link.
type SecureLink struct {
	fc   frameConn
	send cipher.AEAD
	recv cipher.AEAD
	smu  sync.Mutex
	sctr uint64
	rmu  sync.Mutex
	rctr uint64
}

// SecureAsHost runs the E2E handshake as the host (desktop) over a paired Link.
func SecureAsHost(link *Link, secret []byte) (*SecureLink, error) {
	return handshake(link, secret, true)
}

// SecureAsGuest runs the E2E handshake as the guest (agent) over a paired Link.
func SecureAsGuest(link *Link, secret []byte) (*SecureLink, error) {
	return handshake(link, secret, false)
}

func handshake(fc frameConn, secret []byte, isHost bool) (*SecureLink, error) {
	if len(secret) == 0 {
		return nil, errors.New("enroll: empty secret")
	}
	curve := ecdh.X25519()
	priv, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	myPub := priv.PublicKey().Bytes()

	// Exchange ephemeral public keys.
	if err := fc.Send(myPub); err != nil {
		return nil, err
	}
	peerPubBytes, err := fc.Recv()
	if err != nil {
		return nil, err
	}
	peerPub, err := curve.NewPublicKey(peerPubBytes)
	if err != nil {
		return nil, fmt.Errorf("enroll: bad peer key: %w", err)
	}
	dh, err := priv.ECDH(peerPub)
	if err != nil {
		return nil, fmt.Errorf("enroll: ecdh: %w", err)
	}

	// Transcript binds both public keys in a fixed order — a swapped key gives
	// each side a different transcript, hence a different key.
	hostPub, guestPub := myPub, peerPubBytes
	if !isHost {
		hostPub, guestPub = peerPubBytes, myPub
	}
	transcript := make([]byte, 0, len(enrollInfo)+len(hostPub)+len(guestPub))
	transcript = append(transcript, enrollInfo...)
	transcript = append(transcript, hostPub...)
	transcript = append(transcript, guestPub...)

	// Directional keys + a confirmation key. secret (unknown to the relay) is
	// the HKDF salt, so only holders of secret can derive the keys.
	r := hkdf.New(sha256.New, dh, secret, transcript)
	h2g := make([]byte, 32)
	g2h := make([]byte, 32)
	confKey := make([]byte, 32)
	if _, err := io.ReadFull(r, h2g); err != nil {
		return nil, err
	}
	if _, err := io.ReadFull(r, g2h); err != nil {
		return nil, err
	}
	if _, err := io.ReadFull(r, confKey); err != nil {
		return nil, err
	}

	// Key confirmation — detects a wrong code or a man-in-the-middle before any
	// data flows.
	mine := confirmTag(confKey, isHost)
	if err := fc.Send(mine); err != nil {
		return nil, err
	}
	theirs, err := fc.Recv()
	if err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare(theirs, confirmTag(confKey, !isHost)) != 1 {
		return nil, errors.New("enroll: key confirmation failed — wrong code or man-in-the-middle")
	}

	sendKey, recvKey := h2g, g2h
	if !isHost {
		sendKey, recvKey = g2h, h2g
	}
	sendAEAD, err := chacha20poly1305.New(sendKey)
	if err != nil {
		return nil, err
	}
	recvAEAD, err := chacha20poly1305.New(recvKey)
	if err != nil {
		return nil, err
	}
	return &SecureLink{fc: fc, send: sendAEAD, recv: recvAEAD}, nil
}

func confirmTag(key []byte, host bool) []byte {
	m := hmac.New(sha256.New, key)
	if host {
		m.Write([]byte("host-confirm"))
	} else {
		m.Write([]byte("guest-confirm"))
	}
	return m.Sum(nil)
}

// Send encrypts and delivers one frame to the peer. Safe for concurrent use:
// the lock is held across nonce assignment AND the write, so frames leave in
// nonce order (the receiver decrypts with a matching sequential counter).
func (s *SecureLink) Send(plaintext []byte) error {
	s.smu.Lock()
	defer s.smu.Unlock()
	nonce := make([]byte, chacha20poly1305.NonceSize)
	binary.BigEndian.PutUint64(nonce[4:], s.sctr)
	s.sctr++
	return s.fc.Send(s.send.Seal(nil, nonce, plaintext, nil))
}

// Recv receives and decrypts one frame from the peer. Single-reader: the lock
// is held across the read and counter so frame order matches nonce order.
func (s *SecureLink) Recv() ([]byte, error) {
	s.rmu.Lock()
	defer s.rmu.Unlock()
	ct, err := s.fc.Recv()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, chacha20poly1305.NonceSize)
	binary.BigEndian.PutUint64(nonce[4:], s.rctr)
	s.rctr++
	pt, err := s.recv.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("enroll: decrypt failed: %w", err)
	}
	return pt, nil
}

// Close tears down the underlying link.
func (s *SecureLink) Close() error { return s.fc.Close() }
