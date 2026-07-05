// Command blueprint-relay is Blueprint's always-on enrollment relay
// (docs/plan-target-aware-deploy.md §5). It's a small, zero-knowledge
// WebSocket rendezvous: a desktop app registers and gets a join code, an
// agent joins with the code, and the relay forwards opaque (E2E-encrypted)
// frames between them. It never sees plaintext.
//
// TLS modes:
//   -domain relay.example.com   automatic Let's Encrypt on :443 (+ :80 for the
//                               ACME challenge and an http→https redirect).
//                               Self-contained — no reverse proxy needed.
//   -tls-cert/-tls-key          manual TLS on -addr.
//   (neither)                   plain ws on -addr (dev, or behind a TLS LB).
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	"github.com/inspireailab-admin/blueprint-app/internal/relay"
	"golang.org/x/crypto/acme/autocert"
)

func main() {
	addr := flag.String("addr", ":8443", "listen address when -domain/-tls-cert are unset")
	path := flag.String("path", "/enroll", "WebSocket endpoint path")
	domain := flag.String("domain", "", "domain for automatic Let's Encrypt TLS on :443")
	certCache := flag.String("cert-cache", "/var/lib/blueprint-relay/certs", "autocert cache dir")
	certFile := flag.String("tls-cert", "", "TLS certificate (PEM); manual TLS on -addr")
	keyFile := flag.String("tls-key", "", "TLS private key (PEM)")
	flag.Parse()

	mux := http.NewServeMux()
	mux.Handle(*path, relay.NewServer(relay.New()))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	// Automatic Let's Encrypt on :443, ACME + redirect on :80. Fully
	// self-contained; the only outbound call is to Let's Encrypt (the CA).
	if *domain != "" {
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(*domain),
			Cache:      autocert.DirCache(*certCache),
		}
		go func() {
			redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "https://"+r.Host+r.RequestURI, http.StatusMovedPermanently)
			})
			log.Fatal(http.ListenAndServe(":80", m.HTTPHandler(redirect)))
		}()
		srv := &http.Server{
			Addr:              ":443",
			Handler:           mux,
			ReadHeaderTimeout: 10 * time.Second,
			TLSConfig:         m.TLSConfig(),
		}
		log.Printf("blueprint-relay: auto-TLS on :443 for %s%s (ACME on :80)", *domain, *path)
		log.Fatal(srv.ListenAndServeTLS("", ""))
	}

	srv := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	if *certFile != "" && *keyFile != "" {
		log.Printf("blueprint-relay: wss on %s%s", *addr, *path)
		log.Fatal(srv.ListenAndServeTLS(*certFile, *keyFile))
	}
	log.Printf("blueprint-relay: ws on %s%s (no TLS)", *addr, *path)
	log.Fatal(srv.ListenAndServe())
}
