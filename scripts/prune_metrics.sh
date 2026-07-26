#!/bin/bash
# Manually prune aged metrics on the Pod (same policy as the server retention job).
# Prefer the API when free-sleep is running:
#   curl -X POST http://127.0.0.1:3000/api/metrics/prune
set -euo pipefail

if curl -fsS -X POST http://127.0.0.1:3000/api/metrics/prune \
  -H 'Content-Type: application/json' \
  -d '{"force":true}' ; then
  echo ""
  echo "Prune requested via free-sleep API."
  exit 0
fi

echo "API unavailable — falling back is not implemented offline."
echo "Start free-sleep and retry, or check: systemctl status free-sleep"
exit 1
