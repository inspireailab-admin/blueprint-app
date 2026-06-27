// Package secrets is a thin OS-keychain wrapper Blueprint uses to
// cache remote svc bearer tokens between sessions.
//
// Storage backend per platform (handled by zalando/go-keyring):
//   - Windows: Credential Manager via wincred
//   - macOS:   Keychain via the Security framework
//   - Linux:   Secret Service via D-Bus (gnome-keyring / kwallet)
//
// When the platform backend is unavailable (e.g. headless Linux with
// no Secret Service daemon), Get returns ok=false and Set returns a
// non-nil error. Callers should treat both as "no cache" and fall
// back to whatever fresh-fetch path they had before.
//
// Author: Amar Mond.
package secrets

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// Service is the keychain "service" name every Blueprint entry is
// stored under. Pick something distinctive so users can spot
// Blueprint entries when browsing their keychain manually.
const Service = "blueprint-svc-token"

// Get returns the cached secret for account. ok=false means either no
// entry exists or the platform keychain is unavailable.
func Get(account string) (string, bool) {
	s, err := keyring.Get(Service, account)
	if err != nil {
		return "", false
	}
	return s, true
}

// Set stores secret under account. Returns an error when the platform
// keychain is unavailable; callers should log + continue.
func Set(account, secret string) error {
	return keyring.Set(Service, account, secret)
}

// Delete removes the cached entry. Idempotent: a missing entry
// returns nil.
func Delete(account string) error {
	err := keyring.Delete(Service, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
