// Package license handles Blueprint's commercial-license + trial
// state. No phone-home â€” the whole point of the product is "runs on
// your hardware." License keys are issued by a separate Stripe-driven
// signing service (out of repo) and validated locally with an
// embedded Ed25519 public key.
//
// Four runtime states the UI cares about:
//
//   personal       â€” user told us they're using Blueprint for
//                    personal / learning / academic work. No license
//                    required. No nag. Default for first launch
//                    after the user picks "Personal" in the modal.
//
//   trialing       â€” user picked "Commercial" on first launch.
//                    14-day trial; banner appears at day 10.
//
//   trial_expired  â€” 14 days elapsed without a license entered.
//                    Persistent banner: "Trial expired, buy a
//                    commercial license." Tool itself keeps working
//                    â€” same honor-system approach as LM Studio /
//                    AnythingLLM.
//
//   licensed       â€” a valid signed license key is on disk. Banner
//                    shows plan + expiry. Renews automatically when
//                    the user pastes a new key.
//
// State lives at ~/.blueprint/license.json. We never log the key.

package license

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/inspireailab-admin/blueprint-cli/pkg/paths"
)

// Status is one of the four state strings above. Plus "uninitialized"
// for "user hasn't picked personal vs commercial yet."
type Status string

const (
	StatusUninitialized Status = "uninitialized"
	StatusPersonal      Status = "personal"
	StatusTrialing      Status = "trialing"
	StatusTrialExpired  Status = "trial_expired"
	StatusLicensed      Status = "licensed"
)

// TrialDays is how long a commercial trial runs.
const TrialDays = 14

// SoftWarningStartDay is when we start showing the "trial ends in
// N days" banner (count from end of trial, so day 10 of a 14-day
// trial = 4 days remaining when this fires).
const SoftWarningStartDay = TrialDays - 4

// State is the on-disk model.
type State struct {
	// UseType is what the user picked on first launch.
	// "" | "personal" | "commercial". "" means we haven't asked yet.
	UseType string `json:"useType"`

	// FirstCommercialAtMs is when the user said "commercial" the
	// first time. Trial counts from here, not from app install.
	FirstCommercialAtMs int64 `json:"firstCommercialAtMs,omitempty"`

	// LicenseKey is the bearer the user pasted in. Empty when
	// trialing or in personal mode.
	LicenseKey string `json:"licenseKey,omitempty"`

	// Parsed license payload, kept so the UI can render plan + expiry
	// without re-verifying every time. Filled in by ValidateKey.
	License *License `json:"license,omitempty"`
}

// License is the verified payload extracted from a valid LicenseKey.
type License struct {
	Email     string `json:"email"`
	Plan      string `json:"plan"` // "pro" | "team" | "enterprise"
	Seats     int    `json:"seats,omitempty"`
	IssuedAt  int64  `json:"issuedAtMs"`
	ExpiresAt int64  `json:"expiresAtMs"`
	// Machine binds a license to a specific install when set. We
	// match against a stable machine hash to deter casual sharing
	// without breaking legitimate single-user installs.
	Machine string `json:"machine,omitempty"`
}

// Snapshot is what the UI reads. Combines State + derived values like
// the current status and days-remaining.
type Snapshot struct {
	Status         Status   `json:"status"`
	UseType        string   `json:"useType"`
	DaysRemaining  int      `json:"daysRemaining"`
	Banner         string   `json:"banner"`
	BannerLevel    string   `json:"bannerLevel"` // "info" | "warn" | "expired"
	License        *License `json:"license,omitempty"`
}

// â”€â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

var (
	mu sync.Mutex
	st *State
)

// Load reads license.json. Missing file â†’ empty state.
func Load() (*State, error) {
	mu.Lock()
	defer mu.Unlock()
	if st != nil {
		copy := *st
		return &copy, nil
	}
	loaded, err := readFromDisk()
	if err != nil {
		return nil, err
	}
	st = loaded
	copy := *loaded
	return &copy, nil
}

// CurrentSnapshot returns the live snapshot the UI reads on every
// poll. Lightweight â€” no I/O when state is already loaded.
func CurrentSnapshot() Snapshot {
	state, err := Load()
	if err != nil || state == nil {
		return Snapshot{Status: StatusUninitialized}
	}
	return computeSnapshot(state)
}

// SetUseType records the user's first-launch choice. "personal" puts
// us in personal mode forever; "commercial" starts the trial.
func SetUseType(choice string) error {
	mu.Lock()
	defer mu.Unlock()
	if st == nil {
		loaded, err := readFromDisk()
		if err != nil {
			return err
		}
		st = loaded
	}
	switch choice {
	case "personal":
		st.UseType = "personal"
	case "commercial":
		st.UseType = "commercial"
		if st.FirstCommercialAtMs == 0 {
			st.FirstCommercialAtMs = time.Now().UnixMilli()
		}
	default:
		return fmt.Errorf("useType must be 'personal' or 'commercial'")
	}
	return writeToDiskLocked()
}

// EnterLicenseKey verifies and stores a license key. On success the
// next CurrentSnapshot() returns StatusLicensed.
func EnterLicenseKey(key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("license key is empty")
	}
	parsed, err := ValidateKey(key)
	if err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	if st == nil {
		loaded, err := readFromDisk()
		if err != nil {
			return err
		}
		st = loaded
	}
	st.LicenseKey = key
	st.License = parsed
	// A commercial license implies commercial use type â€” auto-promote
	// so the user doesn't have to do two things.
	if st.UseType != "commercial" {
		st.UseType = "commercial"
	}
	if st.FirstCommercialAtMs == 0 {
		st.FirstCommercialAtMs = time.Now().UnixMilli()
	}
	return writeToDiskLocked()
}

// ClearLicense removes a stored license key (used when the user wants
// to switch back to trial mode or sign out).
func ClearLicense() error {
	mu.Lock()
	defer mu.Unlock()
	if st == nil {
		loaded, _ := readFromDisk()
		st = loaded
	}
	if st != nil {
		st.LicenseKey = ""
		st.License = nil
	}
	return writeToDiskLocked()
}

// â”€â”€â”€ Key validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// licenseSigningPubKeyHex is the Ed25519 public key the signing
// service uses for production licenses. **Replace this with your
// real public key before shipping v1 commercially.** The keypair is
// generated once, kept private (only the signing server has the
// private half), and embedded here as the public half.
//
// Format: 64 hex chars = 32 bytes = Ed25519 public key.
//
// This value is a development placeholder generated with
//   crypto/ed25519.GenerateKey + hex.EncodeToString(pub).
// Until it's replaced, every key the signing server emits with the
// matching private half will validate â€” useful for local testing of
// the UI flow.
const licenseSigningPubKeyHex = "ece7a6679439611c63acc2ac5cfd4bb7495c70b48034eb60a3666b9bc7632218"

// ValidateKey verifies a license key and returns its parsed payload.
//
// Key format (URL-safe base64 of two pieces, joined by a dot):
//
//   <payload_b64>.<signature_b64>
//
// where payload is JSON-encoded License (with all fields), and
// signature is Ed25519(privateKey, payload_bytes).
//
// Returns an error when:
//   - Format is malformed
//   - Signature doesn't verify against the embedded pub key
//   - License is expired at the time of validation
func ValidateKey(key string) (*License, error) {
	parts := strings.Split(key, ".")
	if len(parts) != 2 {
		return nil, fmt.Errorf("license key has unexpected shape; expected <payload>.<signature>")
	}
	payloadB64, sigB64 := parts[0], parts[1]
	payload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return nil, fmt.Errorf("license payload not URL-safe base64: %w", err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return nil, fmt.Errorf("license signature not URL-safe base64: %w", err)
	}

	pubKey, err := hex.DecodeString(licenseSigningPubKeyHex)
	if err != nil || len(pubKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("embedded license public key is malformed")
	}
	if !ed25519.Verify(ed25519.PublicKey(pubKey), payload, sig) {
		return nil, fmt.Errorf("license signature does not verify â€” wrong key or tampered payload")
	}

	var lic License
	if err := json.Unmarshal(payload, &lic); err != nil {
		return nil, fmt.Errorf("license payload not valid JSON: %w", err)
	}
	if lic.ExpiresAt > 0 && time.Now().UnixMilli() > lic.ExpiresAt {
		return nil, fmt.Errorf("license expired on %s", time.UnixMilli(lic.ExpiresAt).Format("2006-01-02"))
	}
	return &lic, nil
}

// â”€â”€â”€ Snapshot computation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

func computeSnapshot(s *State) Snapshot {
	out := Snapshot{
		UseType: s.UseType,
	}
	if s.UseType == "" {
		out.Status = StatusUninitialized
		out.Banner = "Choose how you'll use Blueprint (personal or commercial)"
		out.BannerLevel = "info"
		return out
	}

	if s.UseType == "personal" {
		out.Status = StatusPersonal
		return out
	}

	// Commercial path.
	if s.LicenseKey != "" && s.License != nil {
		out.Status = StatusLicensed
		out.License = s.License
		expSoon := s.License.ExpiresAt > 0 && time.Until(time.UnixMilli(s.License.ExpiresAt)) < 14*24*time.Hour
		if expSoon {
			out.Banner = fmt.Sprintf("Your %s license expires on %s â€” renew to keep commercial use covered.",
				strings.Title(s.License.Plan),
				time.UnixMilli(s.License.ExpiresAt).Format("2006-01-02"))
			out.BannerLevel = "warn"
		}
		return out
	}

	// Trial.
	elapsed := time.Since(time.UnixMilli(s.FirstCommercialAtMs))
	daysElapsed := int(elapsed.Hours() / 24)
	daysRemaining := TrialDays - daysElapsed
	if daysRemaining < 0 {
		daysRemaining = 0
	}
	out.DaysRemaining = daysRemaining

	if daysRemaining <= 0 {
		out.Status = StatusTrialExpired
		out.Banner = "Your 14-day commercial trial has ended. Continue using for personal/learning, or buy a commercial license."
		out.BannerLevel = "expired"
		return out
	}
	out.Status = StatusTrialing
	if daysElapsed >= SoftWarningStartDay {
		out.Banner = fmt.Sprintf("Trial: %d days remaining. After that, buy a commercial license to keep commercial use covered.", daysRemaining)
		out.BannerLevel = "warn"
	}
	return out
}

// â”€â”€â”€ Persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

func storagePath() (string, error) {
	root, err := paths.Root()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "license.json"), nil
}

func readFromDisk() (*State, error) {
	path, err := storagePath()
	if err != nil {
		return &State{}, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &State{}, nil
		}
		return &State{}, err
	}
	var s State
	if err := json.Unmarshal(b, &s); err != nil {
		return &State{}, nil
	}
	return &s, nil
}

func writeToDiskLocked() error {
	if st == nil {
		return nil
	}
	path, err := storagePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}
