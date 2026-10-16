#!/usr/bin/env bash
# The Phase IV-A correctness regression (CLOUDPROOF-PHASE-IV-A.md §13): 34 steps,
# one line per step with PASS/FAIL, seconds and key output. Phase IV-B reruns it
# unchanged as condition 8 of the IV-B.0 gate.
#
#   bash tools/regression.sh            # logs in a fresh temp directory
#   REGRESSION_DIR=out bash tools/regression.sh
cd "$(dirname "$0")/.." || exit 1
SP="${REGRESSION_DIR:-$(mktemp -d)}"
rm -rf "$SP" && mkdir -p "$SP"
echo "HEAD $(git rev-parse --short HEAD) dirty=$(git status --porcelain --untracked-files=no | wc -l)"

step() {
  local name="$1"; shift
  local log="$SP/$(echo "$name" | tr ' /' '__').log"
  local t0=$(date +%s)
  ( eval "$@" ) > "$log" 2>&1
  local code=$?
  local t1=$(date +%s)
  local key=$(grep -E "^ℹ (tests|pass|fail) |violations|failures=|killed|combined=|PASS|FAIL|passed|failed|error|Error" "$log" | grep -v "^ℹ (suites|cancelled|skipped|todo)" | tail -4 | tr '\n' ' ' | cut -c1-260)
  if [ $code -eq 0 ]; then echo "PASS $name ($((t1-t0))s) :: $key"; else echo "FAIL $name ($((t1-t0))s, exit $code) :: $key"; fi
}

step "replica npm test" "cd replica && node --test"
step "node suites (sim packages refund-provider tools)" "node --test sim/*.test.js packages/*/*.test.js refund-provider/*.test.js tools/*.test.js"
step "default fingerprint 60 seeds" "node tools/raft-sim-fingerprint.js --runs 60"
step "linearizability search default 100" "node sim/search.js --runs 100 --no-shrink"
for p in group-commit pipeline-only batch-only group-batch group-batch-pipeline optimized-http optimized-binary transport-only group-pipeline group-commit-delay pipeline-delay batched-delay optimized-delay; do
  step "linearizability search $p 200" "node sim/search.js --runs 200 --no-shrink --raft-profile $p"
done
for p in baseline group-commit-delay pipeline-delay batched-delay optimized-delay; do
  step "perf-faults $p 20/scenario" "node sim/perf-faults.js --profile $p --runs 20"
done
step "perf mutants" "node --test sim/perf-mutants.test.js"
step "agent runtime search 1000" "node sim/agent-search.js --workflow refund --runs 1000 --seed 1337 --mutant correct --no-shrink"
step "agent mutant kill benchmark" "node sim/agent-search.js --benchmark --runs 100 --seed 1337"
step "multi-agent search 1000" "node sim/multi-agent-search.js --runs 1000 --seed 1337 --mutant correct --no-shrink --no-artifacts"
step "multi-agent mutant kill benchmark" "node sim/multi-agent-search.js --benchmark --runs 100 --seed 1337 --no-artifacts"
step "Phase I acceptance gate (cloud-search benchmark)" "node sim/cloud-search.js --benchmark --runs 10 --seed 1337 --no-artifacts"
step "Phase I replay failure-1337" "node tools/cloudproof.js replay --file artifacts/cloudproof/failure-1337.json"
step "Phase II-A dataset smoke gate" "node tools/cloudproof-dataset.js --simulations 34 --minimum-simulations 34 --seed 43000 --iterations 10 --budgets 2,4,8 --out '$SP/research-ci'"
step "Phase II-A.2 causal corpus smoke gate" "node tools/cloudproof-causal-corpus.js --simulations 160 --seed 61000 --minimum-trajectories 160 --minimum-matched-pairs 4 --minimum-discordant-pairs 0 --minimum-relational-discordant-pairs 0 --minimum-horizon-positives 1 --max-class-share 1 --pairs 96 --budgets 2,4,8 --workers 2 --shortcut-auroc-hard-max 1 --shortcut-split-max 1 --permutation-mean-band 1 --permutation-trial-band 1 --out '$SP/causal-corpus-ci'"
step "syntax check every module" "find replica refund-provider serving tools sim packages apps -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check"
step "web bundle current" "node tools/build-web.js && git diff --quiet --ignore-cr-at-eol -- web/bundle.js"
step "python ml/cloudproof tests" "python -m pytest ml/cloudproof/tests -q"
git checkout -- web/ 2>/dev/null
echo "DONE"
