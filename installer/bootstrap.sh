#!/bin/sh
# IRIS installer bootstrap for macOS (macOS design doc in docs/, D-M04). ASCII only.
# POSIX sh only -- macOS /bin/sh. Its one job is to get a trusted node running;
# everything after that lives in installer/bootstrap.mjs.
#
# Exit codes (same meaning as bootstrap.ps1): 0 ok, 10 bad location (still in
# a temp folder / missing payload), 11 integrity check failed, 12 could not
# unpack Node, 13 server did not answer in time (from bootstrap.mjs).
set -u

ZIP_ROOT=""
PORT=3460
PASS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --zip-root) ZIP_ROOT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --auto) PASS="$PASS --auto"; shift ;;
    --resume) PASS="$PASS --resume"; shift ;;
    *) shift ;;
  esac
done
case "$ZIP_ROOT" in
  */) ZIP_ROOT="${ZIP_ROOT%/}" ;;
esac

# IRIS_INSTALLER_WORK_DIR is a rehearsal/test seam (installer/lib/platform.mjs
# reads the same variable); real runs use the default.
WORK="${IRIS_INSTALLER_WORK_DIR:-$HOME/Library/Application Support/IRIS-Installer}"
mkdir -p "$WORK"
LOG="$WORK/bootstrap.log"
# Same rotation rule as bootstrap.ps1: past 512KB the log moves to .1.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" | tr -d ' ')" -gt 524288 ]; then
  mv -f "$LOG" "$LOG.1"
fi
printf -- '---- run %s ----\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"
  printf '%s\n' "$*"
}

log "Starting. ZipRoot=$ZIP_ROOT Port=$PORT Flags=$PASS"

# --- Stage: location (exit 10) ---------------------------------------------
# Finder always extracts a zip before anything in it can run, but a copy of
# only the .command file (or a run from a temp folder) has no payload beside it.
MANIFEST="$ZIP_ROOT/payload/manifest.json"
case "$ZIP_ROOT" in
  "${TMPDIR:-/nonexistent-tmp}"*|*/AppTranslocation/*)
    log 'Please move the extracted folder somewhere normal (e.g. Downloads), then run the installer again.'
    exit 10 ;;
esac
if [ -z "$ZIP_ROOT" ] || [ ! -f "$MANIFEST" ]; then
  log 'Please extract the zip file first, then run the installer from the extracted folder.'
  exit 10
fi
log 'Location check passed.'

# --- Stage: Node integrity (exit 11) ----------------------------------------
# Only the Node archive is checked here -- it is the one thing this script
# runs. bootstrap.mjs then checks every other payload part before the server
# starts. plutil reads JSON on every supported macOS; shasum ships with it.
NODE_FILE="$(/usr/bin/plutil -extract parts.node.file raw -o - "$MANIFEST" 2>/dev/null)"
NODE_SHA="$(/usr/bin/plutil -extract parts.node.sha256 raw -o - "$MANIFEST" 2>/dev/null)"
NODE_ARCHIVE="$ZIP_ROOT/payload/$NODE_FILE"
# The resume copy inside an install (<root>/_agent/setup/installer, made by
# setup/handoff.mjs copyInstallerProgram) carries no parts at all. It reuses
# the node already unpacked in $WORK, else the soul's own bundled node.
if [ -z "$NODE_FILE" ] && [ "$(/usr/bin/plutil -extract resumeOnly raw -o - "$MANIFEST" 2>/dev/null)" = "true" ]; then
  for CANDIDATE in "$WORK/node" "$ZIP_ROOT/../../shared/tools/node"; do
    if [ -x "$CANDIDATE/bin/node" ]; then
      log "Resume copy: reusing node at $CANDIDATE."
      # shellcheck disable=SC2086 # PASS is a list of plain flags
      exec "$CANDIDATE/bin/node" "$ZIP_ROOT/installer/bootstrap.mjs" \
        --zip-root "$ZIP_ROOT" --port "$PORT" --node-dir "$CANDIDATE" --work-dir "$WORK" $PASS
    fi
  done
  log 'Resume copy: no node found to reuse. Run the installer from the downloaded zip again.'
  exit 12
fi
if [ -z "$NODE_FILE" ] || [ ! -f "$NODE_ARCHIVE" ]; then
  log "Integrity check failed: node part missing. Download the zip again."
  exit 11
fi
ACTUAL_SHA="$(/usr/bin/shasum -a 256 "$NODE_ARCHIVE" | cut -d ' ' -f 1)"
if [ "$ACTUAL_SHA" != "$NODE_SHA" ]; then
  log "Integrity check failed: $NODE_FILE. Download the zip again."
  exit 11
fi

# --- Stage: portable Node (exit 12) ------------------------------------------
# Unpacked once into $WORK/node and reused while it is the same archive. A
# marker file holds the archive's sha256 so a newer package refreshes it.
NODE_DIR="$WORK/node"
NODE_BIN="$NODE_DIR/bin/node"
if [ -x "$NODE_BIN" ] && [ "$(cat "$NODE_DIR/.iris-archive-sha256" 2>/dev/null)" = "$NODE_SHA" ]; then
  log 'Node already present, reusing.'
else
  rm -rf "$NODE_DIR.new"
  mkdir -p "$NODE_DIR.new"
  if ! /usr/bin/tar -xf "$NODE_ARCHIVE" -C "$NODE_DIR.new" --strip-components 1 || [ ! -x "$NODE_DIR.new/bin/node" ]; then
    rm -rf "$NODE_DIR.new"
    log 'Could not unpack Node.'
    exit 12
  fi
  # Files extracted from a quarantined download can inherit the quarantine
  # flag; Gatekeeper would then stop node on first launch (D-M05).
  /usr/bin/xattr -dr com.apple.quarantine "$NODE_DIR.new" 2>/dev/null
  printf '%s' "$NODE_SHA" > "$NODE_DIR.new/.iris-archive-sha256"
  rm -rf "$NODE_DIR"
  mv "$NODE_DIR.new" "$NODE_DIR"
  log 'Node unpacked.'
fi

# --- Stage: integrity of the rest, stale server, server, browser -------------
# shellcheck disable=SC2086 # PASS is a list of plain flags
exec "$NODE_BIN" "$ZIP_ROOT/installer/bootstrap.mjs" \
  --zip-root "$ZIP_ROOT" --port "$PORT" --node-dir "$NODE_DIR" --work-dir "$WORK" $PASS
