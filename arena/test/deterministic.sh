#!/usr/bin/env bash
# SudoKO arena — deterministic smoke test.
# Drives the whole loop (plant -> steal -> patch -> score) with hardcoded values via
# reducer calls. Same inputs, same result, every run. No LLM, no randomness.
# Run this first, and after every change to the module. Get it green before any agent.
#
#   usage: bash test/deterministic.sh [db-name]
set -euo pipefail
DB="${1:-sudoko-arena}"

pass=0; fail=0
check() { # check <label> <expected-word> <actual-text>
  if echo "$3" | grep -qw -- "$2"; then
    echo "  ok    $1"; pass=$((pass+1))
  else
    echo "  FAIL  $1  (wanted '$2', got: $(echo "$3" | tr '\n' ' '))"; fail=$((fail+1))
  fi
}

echo "== publish =="
spacetime publish "$DB" --project-path . >/dev/null

echo "== scenario =="
spacetime call "$DB" start_match
spacetime call "$DB" plant_flags 1 RED_FLAG_1 BLUE_FLAG_1
spacetime call "$DB" submit_flag red  BLUE_FLAG_1     # red exfiltrates blue's value -> scores
spacetime call "$DB" submit_flag blue WRONG_GUESS     # blue guesses wrong           -> no score
spacetime call "$DB" write_rule  blue '{"path":"/flag"}' block
spacetime call "$DB" record_sla  blue 90
spacetime call "$DB" record_score 1 1 0 100 90

echo "== assert =="
check "red stole 1"        1      "$(spacetime sql "$DB" "SELECT flags_stolen FROM team WHERE id='red'")"
check "blue stole 0"       0      "$(spacetime sql "$DB" "SELECT flags_stolen FROM team WHERE id='blue'")"
check "blue sla is 90"     90     "$(spacetime sql "$DB" "SELECT sla_pct FROM team WHERE id='blue'")"
check "blue flag stolen"   stolen "$(spacetime sql "$DB" "SELECT status FROM flag WHERE owner='blue' AND round=1")"
check "red flag held"      held   "$(spacetime sql "$DB" "SELECT status FROM flag WHERE owner='red' AND round=1")"
check "blue rule written"  block  "$(spacetime sql "$DB" "SELECT action FROM rule WHERE owner='blue'")"
check "score tick logged"  1      "$(spacetime sql "$DB" "SELECT red_flags FROM score_tick WHERE round=1")"

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
