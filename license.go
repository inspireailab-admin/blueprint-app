// License IPC — the Dashboard banner + first-launch modal + the
// "Enter license key" surface all sit on these four methods.

package main

import "github.com/inspireailab-admin/blueprint-app/internal/license"

// LicenseSnapshot is the cheap read the UI polls every few seconds
// (and right after any mutation).
func (a *App) LicenseSnapshot() license.Snapshot {
	return license.CurrentSnapshot()
}

// PickLicenseUseType records the user's first-launch choice. Pass
// "personal" or "commercial".
func (a *App) PickLicenseUseType(choice string) error {
	return license.SetUseType(choice)
}

// SubmitLicenseKey verifies + stores a license key the user pasted.
func (a *App) SubmitLicenseKey(key string) error {
	return license.EnterLicenseKey(key)
}

// ClearLicenseKey wipes the stored license (revert to trial / personal).
func (a *App) ClearLicenseKey() error {
	return license.ClearLicense()
}
