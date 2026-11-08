#!/bin/sh
# IRIS uninstaller for macOS - double-click this file in Finder.
# Rules: the uninstaller design doc in docs/ (same promises as the Windows .cmd).
# ASCII only. Finds a node to run with, copies uninstall.mjs to a temp
# folder (it may be deleting the folder this file lives in) and runs it.
# Pass-through flags: --no-ui --mode keep|all --yes --dry-run --scan.
HERE="$(cd "$(dirname "$0")" && pwd -P)"
WORK="${IRIS_INSTALLER_WORK_DIR:-$HOME/Library/Application Support/IRIS-Installer}"

SCRIPT=""
for S in "$HERE/uninstall.mjs" "$HERE/installer/uninstall.mjs"; do
  if [ -f "$S" ]; then SCRIPT="$S"; break; fi
done
if [ -z "$SCRIPT" ]; then
  echo "uninstall.mjs is missing next to this file. Download the IRIS zip again."
  echo "Press Return to close this window."; read -r _; exit 4
fi

# node: the soul's own (when this is the copy inside an install), the
# installer's work folder, the default install, else the zip's payload.
NODE=""
for N in "$HERE/../../../shared/tools/node/bin/node" "$WORK/node/bin/node" "$HOME/IRIS/_agent/shared/tools/node/bin/node"; do
  if [ -x "$N" ]; then NODE="$N"; break; fi
done
TMP="$(mktemp -d "${TMPDIR:-/tmp}/IRIS-uninstall-XXXXXX")" || exit 4
if [ -z "$NODE" ] && [ -f "$HERE/payload/manifest.json" ]; then
  NF="$(/usr/bin/plutil -extract parts.node.file raw -o - "$HERE/payload/manifest.json" 2>/dev/null)"
  NS="$(/usr/bin/plutil -extract parts.node.sha256 raw -o - "$HERE/payload/manifest.json" 2>/dev/null)"
  if [ -n "$NF" ] && [ -f "$HERE/payload/$NF" ] && [ "$(/usr/bin/shasum -a 256 "$HERE/payload/$NF" | cut -d ' ' -f 1)" = "$NS" ]; then
    mkdir -p "$TMP/node" && /usr/bin/tar -xf "$HERE/payload/$NF" -C "$TMP/node" --strip-components 1 2>/dev/null
    /usr/bin/xattr -dr com.apple.quarantine "$TMP/node" 2>/dev/null
    if [ -x "$TMP/node/bin/node" ]; then NODE="$TMP/node/bin/node"; fi
  fi
fi
if [ -z "$NODE" ]; then
  echo "Could not find the IRIS node program. Nothing was changed."
  echo "Press Return to close this window."; read -r _; rm -rf "$TMP"; exit 4
fi

cp "$SCRIPT" "$TMP/uninstall.mjs" || exit 4
cd "$TMP" || exit 4
"$NODE" "$TMP/uninstall.mjs" "$@"
CODE=$?
rm -rf "$TMP"
exit "$CODE"
