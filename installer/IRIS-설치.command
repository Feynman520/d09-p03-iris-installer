#!/bin/sh
# IRIS installer for macOS - double-click this file in Finder.
# --auto   = automatic update mode, used by the updater. The server still
#            refuses to run silently unless this Mac already has a v2 receipt.
# --resume = continue an install that stopped before the online steps were
#            done. Used by the IRIS window's "continue setup" button.
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
# The zip also carries this file inside installer/. A double-click on that copy
# would look for installer/installer/bootstrap.sh -- the zip root is one up.
if [ ! -f "$ROOT/installer/bootstrap.sh" ] && [ -f "$ROOT/bootstrap.sh" ]; then
  ROOT="$(cd "$ROOT/.." && pwd -P)"
fi
echo "IRIS installer - checking the files, then your browser will open."
/bin/sh "$ROOT/installer/bootstrap.sh" --zip-root "$ROOT" "$@"
CODE=$?
if [ "$CODE" -ne 0 ]; then
  echo ""
  echo "Setup could not start (code $CODE). Log: $HOME/Library/Application Support/IRIS-Installer/bootstrap.log"
  echo "Press Return to close this window."
  read -r _
fi
exit "$CODE"
