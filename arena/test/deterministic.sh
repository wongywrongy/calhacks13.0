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

# --- drone swarm: control must swing BOTH ways, deterministically ---
spacetime call "$DB" deploy_drones 1 4                       # DR-01..DR-04, all neutral
spacetime call "$DB" seize   red  DR-01 TOKEN-1-1            # red exfiltrates token -> seizes
spacetime call "$DB" seize   red  DR-02 TOKEN-1-2            # red takes a second
spacetime call "$DB" seize   blue DR-01 WRONG-TOKEN          # blue wrong token -> no change
spacetime call "$DB" reclaim blue DR-01                      # blue locks out -> control flips back
spacetime call "$DB" seize   blue DR-03 TOKEN-1-3            # blue seizes one of its own

echo "== assert =="
check "red stole 1"        1      "$(spacetime sql "$DB" "SELECT flags_stolen FROM team WHERE id='red'")"
check "blue stole 0"       0      "$(spacetime sql "$DB" "SELECT flags_stolen FROM team WHERE id='blue'")"
check "blue sla is 90"     90     "$(spacetime sql "$DB" "SELECT sla_pct FROM team WHERE id='blue'")"
check "blue flag stolen"   stolen "$(spacetime sql "$DB" "SELECT status FROM flag WHERE owner='blue' AND round=1")"
check "red flag held"      held   "$(spacetime sql "$DB" "SELECT status FROM flag WHERE owner='red' AND round=1")"
check "blue rule written"  block  "$(spacetime sql "$DB" "SELECT action FROM rule WHERE owner='blue'")"
check "score tick logged"  1      "$(spacetime sql "$DB" "SELECT red_flags FROM score_tick WHERE round=1")"

# drone swarm: after the scenario, control is red=1 (DR-02), blue=2 (DR-01,DR-03), neutral=1 (DR-04)
check "DR-01 reclaimed blue" blue    "$(spacetime sql "$DB" "SELECT controlled_by FROM drone WHERE callsign='DR-01'")"
check "DR-02 held by red"    red     "$(spacetime sql "$DB" "SELECT controlled_by FROM drone WHERE callsign='DR-02'")"
check "DR-03 held by blue"   blue    "$(spacetime sql "$DB" "SELECT controlled_by FROM drone WHERE callsign='DR-03'")"
check "DR-04 still neutral"  neutral "$(spacetime sql "$DB" "SELECT controlled_by FROM drone WHERE callsign='DR-04'")"
check "DR-01 last reclaimed" reclaimed "$(spacetime sql "$DB" "SELECT last_action FROM drone WHERE callsign='DR-01'")"

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
