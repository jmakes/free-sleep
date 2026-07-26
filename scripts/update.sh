#!/bin/bash

# Optional: Exit immediately on error
set -e

# Name of the backup folder with a timestamp
print_json_if_exists() {
  local file_path="$1"
  local label="$2"

  if [ -f "$file_path" ]; then
    python3 -m json.tool "$file_path" \
      | sed 's/^/      /' \
      | sed $'s/^/\033[0;90m/' \
      | sed $'s/$/\033[0m/'
  else
    echo "File not found: $file_path"
  fi
}
print_json_if_exists "/home/dac/free-sleep/server/src/serverInfo.json" "Server info"

BACKUP_PATH="/home/dac/free-sleep-backup"
APP_DIR="/home/dac/free-sleep"

# Load fork source config from the currently installed tree BEFORE moving it.
# Defaults keep this fork on jmakes/free-sleep (not upstream).
if [ -f "$APP_DIR/scripts/repo_config.sh" ]; then
  # shellcheck disable=SC1091
  . "$APP_DIR/scripts/repo_config.sh"
else
  FREE_SLEEP_GITHUB_OWNER="${FREE_SLEEP_GITHUB_OWNER:-jmakes}"
  FREE_SLEEP_GITHUB_REPO="${FREE_SLEEP_GITHUB_REPO:-free-sleep}"
  FREE_SLEEP_GITHUB_BRANCH="${FREE_SLEEP_GITHUB_BRANCH:-main}"
  FREE_SLEEP_INSTALL_SCRIPT_URL="${FREE_SLEEP_INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/${FREE_SLEEP_GITHUB_OWNER}/${FREE_SLEEP_GITHUB_REPO}/${FREE_SLEEP_GITHUB_BRANCH}/scripts/install.sh}"
fi

echo "Updating Free Sleep from ${FREE_SLEEP_GITHUB_OWNER}/${FREE_SLEEP_GITHUB_REPO}@${FREE_SLEEP_GITHUB_BRANCH}"
echo "  install script: $FREE_SLEEP_INSTALL_SCRIPT_URL"

systemctl stop free-sleep
systemctl disable free-sleep

# Unblock internet first (needed to reach GitHub)
sh /home/dac/free-sleep/scripts/unblock_internet_access.sh

# If a free-sleep folder exists, back it up
if [ -d /home/dac/free-sleep ]; then
  echo "Backing up current free-sleep to $BACKUP_PATH"
  rm -rf "$BACKUP_PATH"
  mv /home/dac/free-sleep "$BACKUP_PATH"
fi

echo "Attempting to reinstall free-sleep..."
# Preserve fork config via env when the install script is fetched remotely.
# shellcheck disable=SC2086
if FREE_SLEEP_GITHUB_OWNER="$FREE_SLEEP_GITHUB_OWNER" \
   FREE_SLEEP_GITHUB_REPO="$FREE_SLEEP_GITHUB_REPO" \
   FREE_SLEEP_GITHUB_BRANCH="$FREE_SLEEP_GITHUB_BRANCH" \
   FREE_SLEEP_REPO_ZIP_URL="${FREE_SLEEP_REPO_ZIP_URL:-}" \
   FREE_SLEEP_EXTRACTED_DIR="${FREE_SLEEP_EXTRACTED_DIR:-}" \
   /bin/bash -c "$(curl -fsSL "$FREE_SLEEP_INSTALL_SCRIPT_URL")"; then
  echo "Reinstall successful."
  if [ -d "$APP_DIR" ]; then
    rm -rf "$BACKUP_PATH"
  else
    echo "Install path missing after installer; restoring backup..."
    rm -rf "$APP_DIR"
    mv "$BACKUP_PATH" "$APP_DIR"
  fi
else
  echo "Reinstall failed. Restoring from backup..."
  rm -rf /home/dac/free-sleep
  if [ -d "$BACKUP_PATH" ]; then
    mv "$BACKUP_PATH" /home/dac/free-sleep
  fi
fi

systemctl enable free-sleep || true
systemctl start free-sleep || true

# Block internet access again
if [ -f /home/dac/free-sleep/scripts/block_internet_access.sh ]; then
  sh /home/dac/free-sleep/scripts/block_internet_access.sh
fi
echo -e "\033[0;32mUpdate completed successfully!\033[0m"
echo -e "\033[0;32mRestart your pod with 'reboot -h now'\033[0m"
