// Enrollment mode — if a relay join code is configured, this svc dials the
// Blueprint relay and serves the control protocol against the local machine's
// runtime (internal/agentruntime), so a paired desktop can install, pull,
// serve, and monitor over an E2E-encrypted channel. Runs alongside the
// supervisor in the same process, so agent Serve requests (which write
// service-config.json) are picked up by this same supervisor loop.
//
// Config: env BLUEPRINT_ENROLL_CODE (the PAIRID-SECRET code) and optional
// BLUEPRINT_RELAY_URL. The installer sets these on the systemd unit / service.
//
// Author: Amar Mond.
package main

import (
	"context"
	"log"
	"os"
	"sync/atomic"

	"github.com/inspireailab-admin/blueprint-app/internal/agent"
	"github.com/inspireailab-admin/blueprint-app/internal/agentruntime"
)

const defaultRelayURL = "wss://relay.llmblueprint.ai/enroll"

var agentStarted atomic.Bool

// startAgentOnce enrolls this machine with the relay when a join code is set.
// Best-effort and idempotent. Handles one enrollment session (the code is
// single-use); durable reconnection is a follow-up.
func startAgentOnce(ctx context.Context) {
	code := os.Getenv("BLUEPRINT_ENROLL_CODE")
	if code == "" {
		return
	}
	if !agentStarted.CompareAndSwap(false, true) {
		return
	}
	relayURL := os.Getenv("BLUEPRINT_RELAY_URL")
	if relayURL == "" {
		relayURL = defaultRelayURL
	}
	go func() {
		log.Printf("agent: enrolling with relay %s", relayURL)
		if err := agent.Run(ctx, relayURL, code, agentruntime.Runtime{}); err != nil {
			log.Printf("agent: session ended: %v", err)
		}
	}()
}
