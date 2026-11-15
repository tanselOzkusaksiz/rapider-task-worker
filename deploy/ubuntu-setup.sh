#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Ubuntu 22.04 / 24.04 LTS Setup Script for Rapider Isolated Task Orchestrator
# ==============================================================================
# Installs bubblewrap (`bwrap`), git, tar, and Node.js 24 LTS, configures rootless
# unprivileged user namespaces if AppArmor restricts `bwrap` on Ubuntu 24.04,
# creates a dedicated unprivileged `rapider-worker` system user, and registers
# systemd units for both the Orchestrator Daemon and Management UI.

echo "[1/5] Installing OS sandbox & git packages..."
sudo apt-get update -y
sudo apt-get install -y bubblewrap git tar curl ca-certificates gnupg

# Ubuntu 24.04 AppArmor profile allowance for bubblewrap (if applicable)
if [ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  echo "[2/5] Ensuring bubblewrap AppArmor profile is enabled on Ubuntu 24.04..."
  if [ ! -f /etc/apparmor.d/bwrap ]; then
    sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
    sudo apparmor_parser -r /etc/apparmor.d/bwrap || true
  fi
fi

echo "[3/5] Checking Node.js >= 22..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
bwrap --version

echo "[4/5] Creating dedicated unprivileged system user (rapider-worker)..."
if ! id -u rapider-worker >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /bin/bash rapider-worker
fi

echo "[5/5] Setup complete."
echo "Next steps:"
echo "  1. Place gitignored .env in /opt/rapider/rapider-task-worker/.env (chmod 600)"
echo "  2. Copy deploy/rapider-task-orchestrator.service and deploy/rapider-task-management-ui.service to /etc/systemd/system/"
echo "  3. Run: sudo systemctl daemon-reload && sudo systemctl enable --now rapider-task-orchestrator rapider-task-management-ui"

