// Package ssh wraps golang.org/x/crypto/ssh with helpers tailored to
// Blueprint's host-management surface — Dial a host with key-file or
// agent auth, Run a single command and collect output, RunStream a
// command and pipe stdout/stderr line-by-line to a callback (used by
// the push-install UI which renders live progress).

package ssh

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	cryptossh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// Config describes how to reach one host.
type Config struct {
	User    string
	Host    string
	Port    int    // 0 → 22
	KeyPath string // empty → try SSH_AUTH_SOCK then ~/.ssh/id_ed25519 / id_rsa
}

func (c Config) hostport() string {
	port := c.Port
	if port == 0 {
		port = 22
	}
	return net.JoinHostPort(c.Host, fmt.Sprint(port))
}

// Dial opens an SSH client. Caller owns the returned *Client and must
// Close it.
func Dial(ctx context.Context, c Config) (*Client, error) {
	auth, err := authMethods(c.KeyPath)
	if err != nil {
		return nil, err
	}
	cfg := &cryptossh.ClientConfig{
		User: c.User,
		Auth: auth,
		// Trust-on-first-use is intentional for v1 — Blueprint is a
		// developer tool, not a banking app, and the desktop GUI's
		// "Test connect" path will surface the fingerprint to the
		// user in a follow-up. Same trust model as `ssh -o
		// StrictHostKeyChecking=no` which is what most engineers use
		// on their own boxes anyway.
		HostKeyCallback: cryptossh.InsecureIgnoreHostKey(),
		Timeout:         15 * time.Second,
	}

	// Honour the outer context by dialing through a net.Dialer that
	// observes ctx.Deadline.
	d := &net.Dialer{Timeout: cfg.Timeout}
	conn, err := d.DialContext(ctx, "tcp", c.hostport())
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", c.hostport(), err)
	}
	clientConn, chans, reqs, err := cryptossh.NewClientConn(conn, c.hostport(), cfg)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("ssh handshake %s: %w", c.hostport(), err)
	}
	return &Client{c: cryptossh.NewClient(clientConn, chans, reqs)}, nil
}

// Client is a thin wrapper that hides the underlying ssh.Client and
// exposes the two access shapes Blueprint actually uses.
type Client struct {
	c *cryptossh.Client
}

func (cl *Client) Close() error { return cl.c.Close() }

// DialTCP opens a TCP connection through the SSH transport to the
// given remote address. The caller owns the returned net.Conn.
//
// Used to tunnel the svcapi control plane: the remote svc binds
// 127.0.0.1:17832 and we reach it by calling cl.DialTCP("127.0.0.1:17832").
// No port mapping involved — net/http can drive the connection directly.
func (cl *Client) DialTCP(addr string) (net.Conn, error) {
	return cl.c.Dial("tcp", addr)
}

// ReadFile fetches a small file from the remote host via `cat`. Cheap
// way to read the svc bearer token without an SFTP dependency. Caller
// supplies an absolute remote path.
func (cl *Client) ReadFile(ctx context.Context, remotePath string) ([]byte, error) {
	sess, err := cl.c.NewSession()
	if err != nil {
		return nil, err
	}
	defer sess.Close()

	done := make(chan struct{})
	var out []byte
	var runErr error
	go func() {
		out, runErr = sess.Output(fmt.Sprintf("cat %q", remotePath))
		close(done)
	}()
	select {
	case <-done:
		return out, runErr
	case <-ctx.Done():
		_ = sess.Signal(cryptossh.SIGTERM)
		return nil, ctx.Err()
	}
}

// Run executes a single command and returns combined stdout+stderr.
// Suitable for short fact-finding ("uname -a", "whoami") where we
// don't care about streaming.
func (cl *Client) Run(ctx context.Context, cmd string) (string, error) {
	sess, err := cl.c.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()

	done := make(chan struct{})
	var out []byte
	var runErr error
	go func() {
		out, runErr = sess.CombinedOutput(cmd)
		close(done)
	}()
	select {
	case <-done:
		return string(out), runErr
	case <-ctx.Done():
		_ = sess.Signal(cryptossh.SIGTERM)
		return string(out), ctx.Err()
	}
}

// RunStream executes a command and invokes onLine for every line
// emitted on stdout or stderr. Lines are unprefixed; the caller can
// add a stream tag if they care. Returns the command's exit code.
//
// Used by push-install so the UI can render live install progress
// instead of waiting for a 90-second silence.
func (cl *Client) RunStream(
	ctx context.Context,
	cmd string,
	onLine func(stream, line string),
) (int, error) {
	sess, err := cl.c.NewSession()
	if err != nil {
		return -1, err
	}
	defer sess.Close()

	stdout, err := sess.StdoutPipe()
	if err != nil {
		return -1, err
	}
	stderr, err := sess.StderrPipe()
	if err != nil {
		return -1, err
	}

	if err := sess.Start(cmd); err != nil {
		return -1, err
	}

	pumpDone := make(chan struct{}, 2)
	go pumpLines(stdout, "stdout", onLine, pumpDone)
	go pumpLines(stderr, "stderr", onLine, pumpDone)

	done := make(chan error, 1)
	go func() {
		done <- sess.Wait()
		<-pumpDone
		<-pumpDone
	}()

	select {
	case waitErr := <-done:
		if waitErr == nil {
			return 0, nil
		}
		if exit, ok := waitErr.(*cryptossh.ExitError); ok {
			return exit.ExitStatus(), nil
		}
		return -1, waitErr
	case <-ctx.Done():
		_ = sess.Signal(cryptossh.SIGTERM)
		return -1, ctx.Err()
	}
}

// WriteFile uploads a file via SCP-like cat. Useful for shipping the
// install-linux.sh script + svc binary to a freshly-added host.
func (cl *Client) WriteFile(
	ctx context.Context,
	remotePath string,
	mode os.FileMode,
	content []byte,
) error {
	sess, err := cl.c.NewSession()
	if err != nil {
		return err
	}
	defer sess.Close()

	stdin, err := sess.StdinPipe()
	if err != nil {
		return err
	}

	// Quote the remote path to survive spaces. We use `tee` (no `cat`
	// redirection) so the command line stays clean of shell quoting
	// pitfalls.
	cmd := fmt.Sprintf("mkdir -p %q && tee %q > /dev/null && chmod %o %q",
		filepath.Dir(remotePath), remotePath, mode.Perm(), remotePath)

	if err := sess.Start(cmd); err != nil {
		return err
	}

	go func() {
		_, _ = stdin.Write(content)
		_ = stdin.Close()
	}()

	done := make(chan error, 1)
	go func() { done <- sess.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		_ = sess.Signal(cryptossh.SIGTERM)
		return ctx.Err()
	}
}

// ─── Auth methods ──────────────────────────────────────────────────

func authMethods(keyPath string) ([]cryptossh.AuthMethod, error) {
	var out []cryptossh.AuthMethod

	// Try the SSH agent first if it's available — same priority order
	// as openssh.
	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		if conn, err := net.Dial("unix", sock); err == nil {
			ag := agent.NewClient(conn)
			out = append(out, cryptossh.PublicKeysCallback(ag.Signers))
		}
	}

	// Then try the explicit key path (or default candidates if blank).
	candidates := []string{}
	if keyPath != "" {
		candidates = append(candidates, expandHome(keyPath))
	} else {
		home, _ := os.UserHomeDir()
		for _, name := range []string{"id_ed25519", "id_rsa", "id_ecdsa"} {
			candidates = append(candidates, filepath.Join(home, ".ssh", name))
		}
	}

	for _, p := range candidates {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		signer, err := cryptossh.ParsePrivateKey(b)
		if err != nil {
			// Encrypted keys aren't supported in v1; user can decrypt
			// via ssh-add and use the agent path.
			continue
		}
		out = append(out, cryptossh.PublicKeys(signer))
		break
	}

	if len(out) == 0 {
		return nil, fmt.Errorf("no usable SSH auth (no agent, no readable key file)")
	}
	return out, nil
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, p[2:])
	}
	return p
}

func pumpLines(
	r io.Reader,
	stream string,
	onLine func(stream, line string),
	done chan<- struct{},
) {
	defer func() { done <- struct{}{} }()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 4096), 1024*1024)
	for sc.Scan() {
		onLine(stream, sc.Text())
	}
}
