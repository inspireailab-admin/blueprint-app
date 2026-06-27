// Hosts IPC — list / add / update / remove the registry of SSH-managed
// remote machines.
//
// Phase B.1 ships the registry only. Probe (test SSH connect), push-
// install, and remote svc control plane all come in B.2+.
//
// Author: Amar Mond.
package main

import (
	"sync"

	"github.com/inspireailab-admin/blueprint-app/internal/hosts"
	"github.com/inspireailab-admin/blueprint-app/internal/secrets"
)

var (
	hostsOnce sync.Once
	hostsReg  *hosts.Registry
)

func getHosts() *hosts.Registry {
	hostsOnce.Do(func() {
		hostsReg = hosts.New()
	})
	return hostsReg
}

// ListHosts returns every registered host.
func (a *App) ListHosts() []hosts.Host {
	return getHosts().List()
}

// AddHost registers a new SSH target.
func (a *App) AddHost(in hosts.Host) (hosts.Host, error) {
	return getHosts().Add(in)
}

// UpdateHost edits an existing entry by ID.
func (a *App) UpdateHost(in hosts.Host) error {
	return getHosts().Update(in)
}

// RemoveHost drops an entry and clears any keychain-cached svc token
// bound to it (best-effort — a keychain error doesn't fail the
// removal itself).
func (a *App) RemoveHost(id string) error {
	clearHostClient(id)
	_ = secrets.Delete(id)
	return getHosts().Remove(id)
}
