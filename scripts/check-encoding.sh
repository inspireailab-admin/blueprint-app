#!/usr/bin/env bash
# Fails when a tracked text file contains mojibake: UTF-8 that was read as
# Windows-1252 and saved again, which turns "—" into three junk characters
# and "·" into two. It has happened here before (a batch edit on Windows)
# and reached users through CLI output.
#
# The byte sequences are written as escapes so this file never matches
# itself. They are the UTF-8 encodings of:
#   a-circumflex + euro sign           (damaged "—", "…", curly quotes, "•")
#   a-circumflex + right double quote  (damaged box-drawing characters)
#   capital A-circumflex               (damaged "·", "×", non-breaking space)
set -euo pipefail

patterns=(
  $'\xc3\xa2\xe2\x82\xac'
  $'\xc3\xa2\xe2\x80\x9d'
  $'\xc3\x82'
)

args=()
for p in "${patterns[@]}"; do args+=(-e "$p"); done

# -I skips binary files; -F matches the bytes literally.
if LC_ALL=C git grep -I -n -F "${args[@]}" -- . ; then
  echo
  echo "error: mojibake found in the files above (UTF-8 saved through Windows-1252)." >&2
  echo "Re-save them as UTF-8 and restore the original characters." >&2
  exit 1
fi
echo "encoding check: ok"
