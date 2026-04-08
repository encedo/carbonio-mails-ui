#!/usr/bin/env bash
# build-zip.sh — Build carbonio-mails-ui and package into a ZIP for deployment
# Usage: bash build-zip.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Building..."
npm run build

echo "==> Packaging..."
rm -f carbonio-mails-ui.zip
zip -r carbonio-mails-ui.zip dist/ install-mails-ui.sh

COMMIT=$(git rev-parse HEAD)
SIZE=$(du -sh carbonio-mails-ui.zip | cut -f1)
echo ""
echo "Done: carbonio-mails-ui.zip ($SIZE)"
echo "Commit: $COMMIT"
echo ""
echo "Deploy:"
echo "  rsync -av carbonio-mails-ui.zip user@host:/tmp/"
echo "  ssh host 'sudo bash /tmp/install-mails-ui.sh'"
