#!/bin/bash
# Send one contract write from a named CLI account, with a fee estimate taken
# from the chain, and keep the FULL output (it carries the transaction hash).
# Restores whichever account was active before.
#
#   scripts/send_write.sh <account> <contract> <method> <outfile> [args...]
#
# Example (the beneficiary accepts the terms of vault 1):
#   scripts/send_write.sh shiporslash-founder 0x... accept_vault_terms /tmp/accept.out 1
set -u
ACC=$1; CONTRACT=$2; METHOD=$3; OUT=$4; shift 4
PREV=$(genlayer account show 2>/dev/null | sed -n "s/.*name: '\\(.*\\)',/\\1/p" | head -1)
restore() { [ -n "$PREV" ] && genlayer account use "$PREV" >/dev/null 2>&1; }
trap restore EXIT
genlayer account use "$ACC" >/dev/null 2>&1 || { echo "cannot use account $ACC" >&2; exit 2; }
FEES=$(mktemp)
for i in 1 2 3 4 5; do
  RAW=$(genlayer estimate-fees "$CONTRACT" "$METHOD" --args "$@" --json 2>&1)
  if echo "$RAW" | grep -q '"feeValue"'; then
    echo "$RAW" | python3 -c "
import sys, json
t = sys.stdin.read(); d = json.loads(t[t.find('{\"'):] if '{\"' in t else t[t.find('{'):])
for k in ('policy', 'report', 'observed'): d.pop(k, None)
json.dump(d, open('$FEES', 'w'))"
    break
  fi
  echo "fee estimate attempt $i failed: $(echo "$RAW" | grep -m1 -i 'busy\|error' | head -c 140)" >&2
  sleep 45
done
[ -s "$FEES" ] || { echo "could not estimate fees" >&2; exit 3; }
timeout 480 genlayer write "$CONTRACT" "$METHOD" --args "$@" --fees "$(cat "$FEES")" > "$OUT" 2>&1
echo "exit=$? hash=$(grep -A1 'Transaction Hash' "$OUT" | tail -1)"
