#!/usr/bin/env bash
set -euo pipefail

root="${LONGPUZZLEBENCH_OUTPUT:-results/longpuzzlebench-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$root"
outputs=()

cells=(
  "bolt_unscrew easy"
  "bolt_unscrew hard"
  "rush_hour_2 easy"
  "rush_hour_2 medium"
  "rush_hour_2 hard"
  "nut_and_bolt easy"
  "nut_and_bolt medium"
  "nut_and_bolt hard"
  "nut_and_bolt extreme"
  "nut_and_bolt nightmare"
  "truck_escape default"
  "maze_paint easy"
  "maze_paint medium"
  "maze_paint hard"
  "color_connect easy"
  "color_connect hard"
)

for cell in "${cells[@]}"; do
  read -r game difficulty <<<"$cell"
  output="$root/$game/$difficulty"
  uv run longpuzzlebench eval \
    --game "$game" \
    --difficulty "$difficulty" \
    --output "$output" \
    "$@"
  outputs+=("$output")
done

uv run longpuzzlebench leaderboard --input "${outputs[@]}" --output "$root/leaderboard"
printf 'Complete LongPuzzleBench results: %s\n' "$root"
