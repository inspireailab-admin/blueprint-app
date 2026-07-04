// Command blueprint-relay is Blueprint's always-on enrollment relay
// (docs/plan-target-aware-deploy.md §5). It's a small, zero-knowledge
// WebSocket rendezvous: a desktop app registers and gets a join code, an
// agent joins with the code, and the relay forwards opaque (E2E-encrypted)
// frames between them. It never sees plaintext.
//
// Deploy behind TLS on 443 (see docs; e.g. an AWS NLB/ALB terminating TLS, or
// pass -tls-cert/-tls-key to terminate here).
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/relay"
)

func main() {
	addr := flag.String("addr", ":8443", "listen address")
	path := flag.String("path", "/enroll", "WebSocket endpoint path")
	certFile := flag.String("tls-cert", "", "TLS certificate (PEM); enables wss")
	keyFile := flag.String("tls-key", "", "TLS private key (PEM)")
	flag.Parse()

	mux := http.NewServeMux()
	mux.Handle(*path, relay.NewServer(relay.New()))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	if *certFile != "" && *keyFile != "" {
		log.Printf("blueprint-relay: listening wss on %s%s", *addr, *path)
		log.Fatal(srv.ListenAndServeTLS(*certFile, *keyFile))
	}
	log.Printf("blueprint-relay: listening ws on %s%s (NO TLS — dev/behind-LB only)", *addr, *path)
	log.Fatal(srv.ListenAndServe())
}
