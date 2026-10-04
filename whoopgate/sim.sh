#!/bin/sh
# SIMULATED heart rate for demos. Not a real WHOOP reading.
#
# Writes ~/.whoopgate/hr.json once a second, the file the whoopgate daemon
# writes from the band, with "device": "SIMULATED". Stop the real daemon
# first, or the two will overwrite each other.
#
#   ./sim.sh 120          hold around 120 bpm (with a little jitter)
#   ./sim.sh ramp         climb from 80 to 125 bpm, then hold
#   ./sim.sh unlock [s]   pretend `whoopgate breathe` succeeded (default 120 s)
#
# Ctrl-C stops it; the mod treats the file as unknown 30 s later.
set -eu

dir="$HOME/.whoopgate"
mkdir -p "$dir"

case "${1:-}" in
  unlock)
    until=$(( $(date +%s) + ${2:-120} ))
    printf '{"until":%s}\n' "$until" > "$dir/unlock.json"
    echo "SIMULATED unlock until $(date -r "$until" +%H:%M:%S)"
    exit 0
    ;;
  ramp) bpm=80; target=125 ;;
  ''|*[!0-9]*) sed -n '2,12p' "$0"; exit 1 ;;
  *) bpm=$1; target=$1 ;;
esac

recent=""
while :; do
  [ "$bpm" -lt "$target" ] && bpm=$(( bpm + 2 ))
  beat=$(( bpm + $(od -An -N1 -tu1 /dev/urandom | tr -d ' ') % 5 - 2 ))
  recent="${recent:+$recent,}$beat"
  recent=$(printf '%s' "$recent" | tr ',' '\n' | tail -n 30 | paste -sd, -)
  printf '{"bpm":%s,"ts":%s,"recent":[%s],"device":"SIMULATED"}\n' \
    "$beat" "$(date +%s)" "$recent" > "$dir/hr.json.tmp"
  mv "$dir/hr.json.tmp" "$dir/hr.json"
  printf '\r\033[K♥ %s bpm (SIMULATED)' "$beat"
  sleep 1
done
