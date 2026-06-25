#!/usr/bin/env bash
# Blueprint LLM Service installer for Linux.
#
# Installs the service that supervises llama-server. Tested on
# systemd-based distros (Ubuntu, Debian, Fedora, RHEL, etc.).
#
# Usage:
#   sudo ./install-linux.sh
#
# Idempotent — safe to re-run to upgrade the binary.

set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "install-linux.sh: must run as root — re-run with sudo" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "install-linux.sh: systemctl not found — this distro doesn't use systemd" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="${here}/blueprint-svc-linux"

# Fallback for developer flow: build/bin/ alongside the installer dir.
if [[ ! -x "${bin}" ]]; then
  alt="$(cd "${here}/.." && pwd)/build/bin/blueprint-svc-linux"
  if [[ -x "${alt}" ]]; then
    bin="${alt}"
  fi
fi

if [[ ! -x "${bin}" ]]; then
  echo "install-linux.sh: blueprint-svc-linux not found at ${bin}" >&2
  echo "                  build it with .\build.ps1 (cross-compile) and place it next to this script" >&2
  exit 3
fi

echo "Installing Blueprint LLM Service…"
"${bin}" install

cat <<'NEXT'

Service installed and started.

  Status:   sudo systemctl status blueprint-llm
  Logs:     tail -f /var/log/blueprint-svc.log
  Config:   /var/lib/blueprint/service-config.json (managed by the app)
  Status:   /var/lib/blueprint/service-status.json (read by the app)

NEXT
