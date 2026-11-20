#!/usr/bin/env bash
# Run this copy of the experiment against the two specified repository trees.
set -euo pipefail
if [[ $# != 3 || ( $1 != fake && $1 != live ) ]]; then
  echo 'usage: bash eval/run.sh fake|live BASE_REF CANDIDATE_REF' >&2
  exit 2
fi
mode=$1
if [[ $mode == live && -n ${EVAL_PI_AUTH:-} ]]; then
  if [[ $EVAL_PI_AUTH != /* ]]; then
    echo 'EVAL_PI_AUTH must be an absolute path' >&2
    exit 2
  fi
  if [[ -n ${EVAL_BASE_URL:-} || -n ${EVAL_API_KEY:-} ]]; then
    echo 'Use EVAL_PI_AUTH or EVAL_BASE_URL and EVAL_API_KEY, not both' >&2
    exit 2
  fi
fi
runs=${EVAL_RUNS:-1}
if [[ ! $runs =~ ^[1-9][0-9]?$ ]]; then
  echo 'EVAL_RUNS must be an integer from 1 to 99' >&2
  exit 2
fi
case ${EVAL_THINKING:-off} in
  off|minimal|low|medium|high|xhigh) ;;
  *) echo 'EVAL_THINKING must be off, minimal, low, medium, high or xhigh' >&2; exit 2 ;;
esac
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
base=$(git -C "$repo" rev-parse --verify --end-of-options "$2^{commit}")
candidate=$(git -C "$repo" rev-parse --verify --end-of-options "$3^{commit}")
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT

for label in base candidate; do
  ref=${!label}
  code=$root/$label
  mkdir -p "$code"
  git -C "$repo" archive "$ref" | tar -x -C "$code"
  mkdir -p "$code/night-eval"
  cp "$here"/*.ts "$code/night-eval/"
  (cd "$code" && env -u EVAL_API_KEY -u EVAL_PI_AUTH npm ci --no-audit --no-fund >&2)
done

for ((run = 1; run <= runs; run++)); do
  for label in base candidate; do
    trial=$root/$label/trial-$run
    mkdir -p "$trial"
    (
      cd "$trial"
      export HOME="$trial/replay/home" TZ=UTC
      export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
      node --conditions=penelope-source "../night-eval/replay.ts" "$mode" "$label" "${!label}" "$run"
    ) | tee -a "$root/results.jsonl"
  done
done
node "$here/summarize.ts" "$root/results.jsonl"
