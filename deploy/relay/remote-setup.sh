#!/usr/bin/env bash
# Runs ON the relay instance. Installs the uploaded relay binary
# (/tmp/blueprint-relay) as a systemd service that serves wss:// on :443 with
# its own automatic Let's Encrypt cert (Go autocert) — no reverse proxy, no
# third-party downloads. Only outbound call is to Let's Encrypt (the CA).
set -euo pipefail
DOMAIN="relay.llmblueprint.ai"

echo "== install relay binary =="
sudo mkdir -p /opt/blueprint /var/lib/blueprint-relay/certs
sudo mv /tmp/blueprint-relay /opt/blueprint/blueprint-relay
sudo chmod +x /opt/blueprint/blueprint-relay

echo "== systemd unit (runs as root to bind :80/:443) =="
sudo tee /etc/systemd/system/blueprint-relay.service >/dev/null <<EOF
[Unit]
Description=Blueprint enrollment relay (auto-TLS)
After=network.target
[Service]
ExecStart=/opt/blueprint/blueprint-relay -domain ${DOMAIN} -cert-cache /var/lib/blueprint-relay/certs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now blueprint-relay

sleep 4
echo "== status =="
echo "relay: $(sudo systemctl is-active blueprint-relay)"
sudo journalctl -u blueprint-relay --no-pager -n 15 | sed 's/^/  /' || true
