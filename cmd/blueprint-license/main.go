// blueprint-license — tiny CLI that mints signed Blueprint license
// keys. Run it on the billing server (or your laptop while testing)
// with the Ed25519 private key matching the public key embedded in
// internal/license.
//
// Usage:
//
//   # Generate a keypair (one-off; keep the private key SAFE)
//   blueprint-license gen
//
//   # Mint a Pro license valid for 1 year
//   blueprint-license sign \
//     --priv $BLUEPRINT_LICENSE_PRIV \
//     --email user@example.com \
//     --plan pro \
//     --days 365
//
//   # Mint a Team license (5 seats)
//   blueprint-license sign \
//     --priv $BLUEPRINT_LICENSE_PRIV \
//     --email team@example.com \
//     --plan team \
//     --seats 5 \
//     --days 365
//
// The output is the user-facing license key (two URL-safe base64
// chunks joined by a dot). Email it to the user; they paste it into
// Blueprint.
//
// Production setup: wire this into a Stripe webhook handler. On
// "checkout.session.completed", call sign() with the email + plan
// from the line item + 365 days, post the result to a transactional
// email (Resend, Postmark, etc.). 50 lines of code.

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"
)

type License struct {
	Email     string `json:"email"`
	Plan      string `json:"plan"`
	Seats     int    `json:"seats,omitempty"`
	IssuedAt  int64  `json:"issuedAtMs"`
	ExpiresAt int64  `json:"expiresAtMs"`
	Machine   string `json:"machine,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "gen":
		gen()
	case "sign":
		sign(os.Args[2:])
	case "verify":
		verify(os.Args[2:])
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Println(`blueprint-license — mint Blueprint commercial license keys.

Commands:
  gen                    Generate a new Ed25519 keypair.
  sign --priv HEX        Sign + emit a license key.
       --email STR
       --plan pro|team|enterprise
       --seats N         (optional)
       --days N          (default 365)
       --machine STR     (optional)
  verify --pub HEX KEY   Validate a license key against a public key.`)
}

// ── gen ─────────────────────────────────────────────────────────────

func gen() {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fmt.Fprintln(os.Stderr, "generate keypair:", err)
		os.Exit(1)
	}
	fmt.Println("Public key  (embed this in internal/license/license.go):")
	fmt.Println("  " + hex.EncodeToString(pub))
	fmt.Println()
	fmt.Println("Private key (keep SECRET — put on the billing server):")
	fmt.Println("  " + hex.EncodeToString(priv))
	fmt.Println()
	fmt.Println("Recommended: store the private key in an env var or secret manager,")
	fmt.Println("NEVER commit it to the repo.")
}

// ── sign ────────────────────────────────────────────────────────────

func sign(args []string) {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	privHex := fs.String("priv", "", "Ed25519 private key (hex)")
	email := fs.String("email", "", "subscriber email")
	plan := fs.String("plan", "pro", "pro | team | enterprise")
	seats := fs.Int("seats", 0, "number of seats (for team plans)")
	days := fs.Int("days", 365, "license validity in days")
	machine := fs.String("machine", "", "optional machine binding")
	_ = fs.Parse(args)

	if *privHex == "" || *email == "" {
		fmt.Fprintln(os.Stderr, "--priv and --email are required")
		os.Exit(2)
	}

	priv, err := hex.DecodeString(*privHex)
	if err != nil || len(priv) != ed25519.PrivateKeySize {
		fmt.Fprintln(os.Stderr, "private key must be a hex-encoded Ed25519 private key")
		os.Exit(2)
	}

	now := time.Now().UnixMilli()
	expires := time.Now().AddDate(0, 0, *days).UnixMilli()

	lic := License{
		Email:     *email,
		Plan:      *plan,
		Seats:     *seats,
		IssuedAt:  now,
		ExpiresAt: expires,
		Machine:   *machine,
	}
	payload, err := json.Marshal(lic)
	if err != nil {
		fmt.Fprintln(os.Stderr, "marshal payload:", err)
		os.Exit(1)
	}

	sig := ed25519.Sign(ed25519.PrivateKey(priv), payload)

	key := base64.RawURLEncoding.EncodeToString(payload) +
		"." + base64.RawURLEncoding.EncodeToString(sig)

	fmt.Println(key)
}

// ── verify ──────────────────────────────────────────────────────────

func verify(args []string) {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	pubHex := fs.String("pub", "", "Ed25519 public key (hex)")
	_ = fs.Parse(args)
	if *pubHex == "" || fs.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: verify --pub HEX KEY")
		os.Exit(2)
	}
	pub, err := hex.DecodeString(*pubHex)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		fmt.Fprintln(os.Stderr, "public key must be a hex-encoded Ed25519 public key")
		os.Exit(2)
	}
	key := fs.Arg(0)
	// Split on the dot.
	var payloadB64, sigB64 string
	for i, c := range key {
		if c == '.' {
			payloadB64 = key[:i]
			sigB64 = key[i+1:]
			break
		}
	}
	if payloadB64 == "" || sigB64 == "" {
		fmt.Fprintln(os.Stderr, "license key has wrong shape; expected <payload>.<signature>")
		os.Exit(1)
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		fmt.Fprintln(os.Stderr, "payload not URL-safe base64:", err)
		os.Exit(1)
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		fmt.Fprintln(os.Stderr, "signature not URL-safe base64:", err)
		os.Exit(1)
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), payload, sig) {
		fmt.Println("INVALID — signature does not verify")
		os.Exit(1)
	}
	var lic License
	if err := json.Unmarshal(payload, &lic); err != nil {
		fmt.Fprintln(os.Stderr, "payload not valid JSON:", err)
		os.Exit(1)
	}
	out, _ := json.MarshalIndent(lic, "", "  ")
	fmt.Println("VALID:")
	fmt.Println(string(out))
}
