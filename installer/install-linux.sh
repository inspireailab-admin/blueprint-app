#!/usr/bin/env bash
# Blueprint LLM Service installer for Linux.
#
# Installs the service that supervises llama-server. Tested on
# systemd-based distros (Ubuntu, Debian, Fedora, RHEL, etc.).
#
# Usage:
#   sudo ./install-linux.sh                     # install/upgrade the service
#   sudo ./install-linux.sh --code PAIRID-SECRET  # + enroll with the relay
#
# The join code comes from the Blueprint desktop app (Machines → Add a machine).
# Idempotent — safe to re-run to upgrade the binary.

set -euo pipefail

CODE="${BLUEPRINT_ENROLL_CODE:-}"
RELAY_URL="${BLUEPRINT_RELAY_URL:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --code) CODE="${2:-}"; shift 2 ;;
    --relay-url) RELAY_URL="${2:-}"; shift 2 ;;
    *) echo "install-linux.sh: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

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
# The svc reads these on start; `install` bakes them into the systemd unit.
export BLUEPRINT_ENROLL_CODE="${CODE}"
[[ -n "${RELAY_URL}" ]] && export BLUEPRINT_RELAY_URL="${RELAY_URL}"
"${bin}" install

if [[ -n "${CODE}" ]]; then
  cat <<'NEXT'

Service installed and enrolling with the relay.
This machine should appear in the Blueprint app (Machines) within a few seconds.

  Status:   sudo systemctl status blueprint-llm
  Logs:     tail -f /var/log/blueprint-svc.log

NEXT
else
  cat <<'NEXT'

Service installed and started.

  Status:   sudo systemctl status blueprint-llm
  Logs:     tail -f /var/log/blueprint-svc.log
  Config:   /var/lib/blueprint/service-config.json (managed by the app)
  Status:   /var/lib/blueprint/service-status.json (read by the app)

NEXT
fi
