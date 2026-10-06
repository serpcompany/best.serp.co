#!/bin/sh
# Assemble ../index.html from the parts in this directory and syntax-check the script.
# Same order and framing as the design agent's build.sh, so the output is byte-identical.
set -e
D=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/submissions-mockups.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
JS="$TMP/all.js"
cat "$D/b-core.js" "$D/c-screens-1-4.js" "$D/d-screens-5-9.js" "$D/d2-messages.js" "$D/e-screens-10-14.js" "$D/e2-inbox.js" "$D/f-emails.js" "$D/f2-registry.js" "$D/g-boot.js" > "$JS"
node --check "$JS"
{
  cat "$D/a-shell.html"
  echo '<script>'
  cat "$JS"
  echo '</script>'
} > "$D/../index.html"
wc -c "$D/../index.html"
