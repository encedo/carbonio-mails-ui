#!/usr/bin/env bash
# install-mails-ui.sh — Install forked carbonio-mails-ui on a Carbonio server
# Copy this script to the server together with carbonio-mails-ui.zip, then run:
#   sudo bash /tmp/install-mails-ui.sh
#
# Assumes carbonio-mails-ui.zip is in the same directory as this script.

set -euo pipefail

IRIS=/opt/zextras/web/iris
ZIP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIP="$ZIP_DIR/carbonio-mails-ui.zip"

if [[ ! -f "$ZIP" ]]; then
    echo "ERROR: $ZIP not found"
    exit 1
fi

# ── Unzip ────────────────────────────────────────────────────────────────────
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
unzip -q "$ZIP" -d "$TMP"

# ── Read commit hash from component.json ─────────────────────────────────────
COMMIT=$(python3 -c "import json; print(json.load(open('$TMP/dist/component.json'))['commit'])")
echo "==> Installing carbonio-mails-ui commit ${COMMIT:0:8}..."

# ── Backup existing mails-ui entry from components.json ──────────────────────
python3 << PYEOF
import json
components_path = '$IRIS/components.json'
with open(components_path) as f:
    root = json.load(f)
existing = [x for x in root['components'] if x.get('name') == 'carbonio-mails-ui']
if existing:
    print(f"    Replacing existing: {existing[0].get('commit','?')[:8]}")
else:
    print(f"    No existing carbonio-mails-ui entry found")
PYEOF

# ── Copy files ───────────────────────────────────────────────────────────────
mkdir -p "$IRIS/carbonio-mails-ui/$COMMIT"
cp -r "$TMP/dist/." "$IRIS/carbonio-mails-ui/$COMMIT/"
chown -R zextras:zextras "$IRIS/carbonio-mails-ui/$COMMIT/"
echo "    Files copied to $IRIS/carbonio-mails-ui/$COMMIT/"

# ── Register in components.json ──────────────────────────────────────────────
python3 << PYEOF
import json

components_path = '$IRIS/components.json'
component_path  = '$IRIS/carbonio-mails-ui/$COMMIT/component.json'

with open(components_path) as f:
    root = json.load(f)

with open(component_path) as f:
    new = json.load(f)

root['components'] = [x for x in root['components'] if x.get('name') != 'carbonio-mails-ui']
root['components'].append(new)

with open(components_path, 'w') as f:
    json.dump(root, f, indent=2)

print(f"    Registered: {new['name']} {new['commit'][:8]}")
PYEOF

chown zextras:zextras "$IRIS/components.json"

echo ""
echo "==> Done. Hard-reload the browser (Ctrl+Shift+R) to activate."
echo ""
echo "Rollback — restore original mails-ui:"
echo "  sudo python3 -c \""
echo "  import json; p='$IRIS/components.json'; r=json.load(open(p));"
echo "  r['components']=[x for x in r['components'] if x.get('name')!='carbonio-mails-ui'];"
echo "  json.dump(r,open(p,'w'))"
echo "  \""
echo "  Then re-run Carbonio package manager to reinstall original."
