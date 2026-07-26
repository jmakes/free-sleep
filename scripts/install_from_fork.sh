#!/bin/bash
# -----------------------------------------------------------------------------
# One-shot installer for this fork, intended to be run ON the Pod (as root).
#
# From an existing Free Sleep install (upstream or prior fork):
#   sh /path/to/install_from_fork.sh
#
# Or remotely:
#   ssh -p 8822 root@POD_IP 'bash -s' < scripts/install_from_fork.sh
#
# This is a thin wrapper around install.sh with fork defaults.
# User data under /persistent/free-sleep-data/ is preserved.
# -----------------------------------------------------------------------------
set -euo pipefail

FREE_SLEEP_GITHUB_OWNER="${FREE_SLEEP_GITHUB_OWNER:-jmakes}"
FREE_SLEEP_GITHUB_REPO="${FREE_SLEEP_GITHUB_REPO:-free-sleep}"
FREE_SLEEP_GITHUB_BRANCH="${FREE_SLEEP_GITHUB_BRANCH:-main}"

INSTALL_URL="https://raw.githubusercontent.com/${FREE_SLEEP_GITHUB_OWNER}/${FREE_SLEEP_GITHUB_REPO}/${FREE_SLEEP_GITHUB_BRANCH}/scripts/install.sh"

echo "=== Free Sleep fork install ==="
echo "  source: ${FREE_SLEEP_GITHUB_OWNER}/${FREE_SLEEP_GITHUB_REPO}@${FREE_SLEEP_GITHUB_BRANCH}"
echo "  script: $INSTALL_URL"
echo ""
echo "This replaces /home/dac/free-sleep but keeps /persistent/free-sleep-data/"
echo ""

# Prefer local backup if we are already on a free-sleep tree
if [ -d /home/dac/free-sleep ] && [ ! -d /home/dac/free-sleep-known-good ]; then
  echo "Saving known-good copy to /home/dac/free-sleep-known-good"
  cp -a /home/dac/free-sleep /home/dac/free-sleep-known-good
fi

if [ -f /home/dac/free-sleep/scripts/unblock_internet_access.sh ]; then
  echo "Temporarily unblocking WAN (needed to reach GitHub)..."
  sh /home/dac/free-sleep/scripts/unblock_internet_access.sh || true
fi

export FREE_SLEEP_GITHUB_OWNER FREE_SLEEP_GITHUB_REPO FREE_SLEEP_GITHUB_BRANCH

echo "Downloading and running install.sh..."
/bin/bash -c "$(curl -fsSL "$INSTALL_URL")"

if [ -f /home/dac/free-sleep/scripts/block_internet_access.sh ]; then
  echo "Re-applying WAN block (if previously used)..."
  # Only re-block if the user had been blocking; block script is safe to re-run.
  # Comment out if you want the Pod to keep internet after install.
  # sh /home/dac/free-sleep/scripts/block_internet_access.sh || true
  echo "(Skipping auto re-block — run block_internet_access.sh yourself if desired)"
fi

echo ""
echo -e "\033[0;32mFork install finished.\033[0m"
echo "Check: systemctl status free-sleep --no-pager"
echo "UI:    http://<pod-ip>:3000/"
echo "Rollback: see FORK.md"
