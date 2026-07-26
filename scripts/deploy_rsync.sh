#!/bin/bash
# -----------------------------------------------------------------------------
# Deploy a local free-sleep tree to a Pod over SSH/rsync (iteration path).
#
# Usage:
#   ./scripts/deploy_rsync.sh root@<POD_HOST>
#   ./scripts/deploy_rsync.sh root@<POD_HOST> --port 8822
#   ./scripts/deploy_rsync.sh root@<POD_HOST> --port 8822 --build
#   ./scripts/deploy_rsync.sh root@<POD_HOST> --port 8822 --skip-backup
#
# Defaults: SSH port 8822 (Free Sleep setup_ssh.sh), remote path /home/dac/free-sleep
# -----------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_PATH="/home/dac/free-sleep"
SSH_PORT=8822
DO_BUILD=0
DO_BACKUP=1
RESTART=1
TARGET=""

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \?//'
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage ;;
    --port|-p)
      SSH_PORT="${2:?--port requires a value}"
      shift 2
      ;;
    --build)
      DO_BUILD=1
      shift
      ;;
    --skip-backup)
      DO_BACKUP=0
      shift
      ;;
    --no-restart)
      RESTART=0
      shift
      ;;
    --remote-path)
      REMOTE_PATH="${2:?--remote-path requires a value}"
      shift 2
      ;;
    -*)
      echo "Unknown option: $1"
      usage
      ;;
    *)
      if [ -n "$TARGET" ]; then
        echo "Unexpected argument: $1"
        usage
      fi
      TARGET="$1"
      shift
      ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "ERROR: missing target, e.g. root@<POD_HOST>"
  usage
fi

SSH_OPTS=(-p "$SSH_PORT" -o StrictHostKeyChecking=accept-new)
RSYNC_SSH="ssh -p $SSH_PORT -o StrictHostKeyChecking=accept-new"

echo "==> Deploy target: $TARGET (port $SSH_PORT)"
echo "    local:  $ROOT_DIR"
echo "    remote: $REMOTE_PATH"

echo ""
echo "==> Checking SSH connectivity"
if ! ssh "${SSH_OPTS[@]}" "$TARGET" "test -d /home/dac && echo ok"; then
  echo "ERROR: cannot SSH to $TARGET on port $SSH_PORT"
  echo "Ensure setup_ssh.sh was run on the Pod and your key is authorized."
  exit 1
fi

if [ "$DO_BUILD" -eq 1 ]; then
  echo ""
  echo "==> Building release artifacts locally"
  sh "$ROOT_DIR/scripts/build_release.sh"
fi

if [ ! -f "$ROOT_DIR/server/dist/server.js" ]; then
  echo "ERROR: server/dist/server.js missing. Run with --build or ./scripts/build_release.sh first."
  exit 1
fi
if [ ! -f "$ROOT_DIR/server/public/index.html" ]; then
  echo "ERROR: server/public/index.html missing. Run with --build or ./scripts/build_release.sh first."
  exit 1
fi

# Keep serverInfo.json in dist aligned with source even without a full rebuild
cp -f "$ROOT_DIR/server/src/serverInfo.json" "$ROOT_DIR/server/dist/serverInfo.json"

STAMP="$(date +%Y%m%d-%H%M%S)"
if [ "$DO_BACKUP" -eq 1 ]; then
  echo ""
  echo "==> Backing up remote free-sleep on the Pod"
  ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s" <<EOF
set -euo pipefail
if [ -d "$REMOTE_PATH" ]; then
  BACKUP="/home/dac/free-sleep-rsync-backup-$STAMP"
  echo "Copying $REMOTE_PATH -> \$BACKUP"
  cp -a "$REMOTE_PATH" "\$BACKUP"
  echo "Backup at \$BACKUP"
else
  echo "No existing $REMOTE_PATH — skipping backup"
fi
EOF
fi

echo ""
echo "==> Stopping free-sleep service(s)"
ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s" <<'EOF'
set -euo pipefail
for svc in free-sleep free-sleep-stream; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${svc}.service"; then
    systemctl stop "$svc" || true
  fi
done
EOF

echo ""
echo "==> rsync code (excluding node_modules, .git, local data, logs)"
# -a archive, -z compress, --delete removes remote files deleted locally in synced trees
# We deliberately do NOT --delete at the top level to avoid wiping remote-only state.
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'app/node_modules/' \
  --exclude 'server/node_modules/' \
  --exclude 'app/dist/' \
  --exclude 'server/free-sleep-data/' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  -e "$RSYNC_SSH" \
  "$ROOT_DIR/" \
  "$TARGET:$REMOTE_PATH/"

echo ""
echo "==> Fixing ownership and checking npm deps"
ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s" <<EOF
set -euo pipefail
chown -R dac:dac "$REMOTE_PATH"

SERVER_DIR="$REMOTE_PATH/server"
BACKUP_LOCK="/home/dac/free-sleep-rsync-backup-$STAMP/server/package-lock.json"
NEW_LOCK="\$SERVER_DIR/package-lock.json"
NEED_INSTALL=1

if [ -f "\$BACKUP_LOCK" ] && [ -f "\$NEW_LOCK" ]; then
  if [ "\$(sha256sum "\$BACKUP_LOCK" | awk '{print \$1}')" = "\$(sha256sum "\$NEW_LOCK" | awk '{print \$1}')" ]; then
    if [ -d "\$SERVER_DIR/node_modules" ]; then
      NEED_INSTALL=0
      echo "package-lock.json unchanged — keeping existing node_modules"
    fi
  fi
fi

if [ "\$NEED_INSTALL" -eq 1 ]; then
  echo "Running npm install for server..."
  if [ -x /home/dac/.volta/bin/npm ]; then
    su - dac -c "cd '\$SERVER_DIR' && /home/dac/.volta/bin/npm install"
  else
    su - dac -c "cd '\$SERVER_DIR' && npm install"
  fi
fi

# Ensure shortcuts/update script bits remain executable
chmod +x "$REMOTE_PATH"/scripts/*.sh 2>/dev/null || true
EOF

if [ "$RESTART" -eq 1 ]; then
  echo ""
  echo "==> Restarting free-sleep"
  ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s" <<'EOF'
set -euo pipefail
systemctl daemon-reload || true
if [ -f /home/dac/free-sleep/scripts/restart.sh ]; then
  sh /home/dac/free-sleep/scripts/restart.sh
else
  systemctl enable free-sleep 2>/dev/null || true
  systemctl start free-sleep
fi
sleep 2
systemctl is-active free-sleep && echo "free-sleep is active" || {
  echo "WARNING: free-sleep not active"
  systemctl status free-sleep --no-pager || true
  exit 1
}
EOF
fi

echo ""
echo -e "\033[0;32mDeploy complete.\033[0m"
echo "Open http://<pod-ip>:3000/ and verify temperature control still works."
echo "Rollback tip: on the Pod, stop the service and restore the rsync backup folder under /home/dac/"
