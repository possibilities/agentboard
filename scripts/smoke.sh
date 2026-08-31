#!/usr/bin/env bash
set -euo pipefail

# End-to-end smoke test: exercises every agentboard command that returns
# against a throwaway database and prints a readable transcript, failing loudly
# on the first unexpected result. `mcp` is the one command left out — it serves
# until its transport closes rather than returning, and test/mcp.test.ts drives
# it with a real MCP client instead. See scripts/install.sh for the house shell
# style this follows (strict mode, small helper functions, prose comments).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
MAIN="$ROOT/src/main.ts"

CHECKS=0
TMP_DIR=""
LAST_OUT=""

cleanup() {
  local status=$?
  if [[ -n "$TMP_DIR" ]]; then
    rm -f -- "${AGENTBOARD_DB:-}-wal" "${AGENTBOARD_DB:-}-shm" 2>/dev/null || true
    rm -rf -- "$TMP_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

die() {
  echo "smoke: $1" >&2
  exit 1
}

section() {
  echo
  echo "== $* =="
}

fail_step() {
  echo "FAIL: $1" >&2
  echo "  command: agentboard $2" >&2
  exit 1
}

# --- Setup ---

command -v bun >/dev/null 2>&1 || die "bun is required but was not found in PATH"
[[ -x "$MAIN" ]] || die "expected an executable command at $MAIN"

TMP_DIR="$(mktemp -d)"
export AGENTBOARD_DB="$TMP_DIR/board.sqlite3"
ERR_FILE="$TMP_DIR/.stderr"

# The one rule this script cannot break: never touch the real board.
case "$AGENTBOARD_DB" in
  "$TMP_DIR"/*) ;;
  *) die "refusing to run: AGENTBOARD_DB is not inside the temp directory: $AGENTBOARD_DB" ;;
esac
[[ "$AGENTBOARD_DB" != "$HOME/.local/share/agentboard/board.sqlite3" ]] ||
  die "refusing to run: AGENTBOARD_DB resolved to the real board"

echo "smoke: using throwaway board at $AGENTBOARD_DB"

# --- Command runners ---

# Runs `bun $MAIN "$@"`, printing the invocation and its output as the
# transcript, and leaves the result in $LAST_OUT / $LAST_ERR / $LAST_STATUS.
run_agentboard() {
  echo "+ agentboard $*"
  set +e
  LAST_OUT="$(bun "$MAIN" "$@" 2>"$ERR_FILE")"
  LAST_STATUS=$?
  set -e
  LAST_ERR="$(cat "$ERR_FILE")"
  [[ -z "$LAST_OUT" ]] || printf '%s\n' "$LAST_OUT"
  [[ -z "$LAST_ERR" ]] || printf '%s\n' "$LAST_ERR" >&2
}

# Runs a command that must succeed (exit 0).
expect_ok() {
  run_agentboard "$@"
  [[ "$LAST_STATUS" -eq 0 ]] || fail_step "expected exit 0, got $LAST_STATUS" "$*"
  CHECKS=$((CHECKS + 1))
}

# Runs a command that must fail with a specific exit code and a specific
# error.code inside the --json envelope.
expect_fail() {
  local want_status="$1" want_code="$2"
  shift 2
  run_agentboard "$@"
  [[ "$LAST_STATUS" -eq "$want_status" ]] ||
    fail_step "expected exit $want_status, got $LAST_STATUS" "$*"
  local got_code
  got_code="$(printf '%s' "$LAST_OUT" | json_field error.code)" ||
    fail_step "expected an error.code in the envelope but found none" "$*"
  [[ "$got_code" == "$want_code" ]] ||
    fail_step "expected error.code \"$want_code\", got \"$got_code\"" "$*"
  CHECKS=$((CHECKS + 1))
}

# Runs a command that must fail as a usage fault: exit 2, empty stdout, help
# on stderr, and never a --json envelope.
expect_usage_fault() {
  run_agentboard "$@"
  [[ "$LAST_STATUS" -eq 2 ]] || fail_step "expected exit 2, got $LAST_STATUS" "$*"
  [[ -z "$LAST_OUT" ]] || fail_step "expected empty stdout on a usage fault" "$*"
  [[ -n "$LAST_ERR" ]] || fail_step "expected help text on stderr" "$*"
  CHECKS=$((CHECKS + 1))
}

# Pulls a dotted field path (e.g. "data.baseRevision") out of JSON on stdin,
# via `bun -e` rather than jq.
json_field() {
  local path="$1"
  bun -e "
    const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    let cur = data;
    for (const key of '$path'.split('.')) {
      cur = cur === null || cur === undefined ? undefined : cur[key];
    }
    if (cur === undefined) process.exit(1);
    process.stdout.write(typeof cur === 'string' ? cur : JSON.stringify(cur));
  "
}

# Shorthand for the common case of pulling one field out of $LAST_OUT.
last_field() {
  printf '%s' "$LAST_OUT" | json_field "$1"
}

assert_contains() {
  local haystack="$1" needle="$2" what="$3"
  [[ "$haystack" == *"$needle"* ]] || fail_step "expected $what to contain: $needle" "(see transcript above)"
}

# --- Global flags ---

section "Global flags"
expect_ok --help
expect_ok --version
expect_ok --agent-help
expect_ok --agent-teaser

# --- Reads on an empty board ---

section "Reads on an empty board"
expect_ok list
expect_ok list --all
expect_ok list --jsonl
expect_ok search nothing-yet
expect_ok ready
expect_ok ready --jsonl
expect_ok tree
expect_ok graph
expect_ok graph --jsonl
expect_ok brief
expect_ok brief --spoken
expect_ok state
expect_ok state --budget 200
expect_ok guide --json

# --- Capturing items ---

section "Capturing items: add, --new, existing_topic"
expect_ok add the login timeout bug --title "Login timeout defect" \
  --summary "times out after 30s" --tag bug,auth --json
ITEM_LOGIN="$(last_field data.id)"

expect_fail 1 existing_topic add the login timeout bug --json

expect_ok add the login timeout bug --new --json
ITEM_LOGIN2="$(last_field data.id)"

expect_ok add improve the search index --summary "faster queries" \
  --tag search,perf --origin agent --json
ITEM_SEARCH="$(last_field data.id)"

expect_ok add ship the new onboarding flow --tag product --json
ITEM_ONBOARD="$(last_field data.id)"

expect_ok add write the release notes --tag docs --json
ITEM_RELEASE="$(last_field data.id)"

expect_ok add spike on the old caching layer --tag infra --json
ITEM_CACHE="$(last_field data.id)"

expect_ok add draft the api spec v1 --tag api --json
ITEM_APIV1="$(last_field data.id)"

expect_ok add draft the api spec v2 --tag api --json
ITEM_APIV2="$(last_field data.id)"

expect_ok add investigate the flaky ci job --tag ci --json
ITEM_CI="$(last_field data.id)"

expect_ok add polish the settings page --tag ux --json
ITEM_SETTINGS="$(last_field data.id)"

expect_ok add polish the dashboard charts --tag ux --json
ITEM_DASH1="$(last_field data.id)"

expect_ok add polish the dashboard layout --tag ux --json
ITEM_DASH2="$(last_field data.id)"

expect_ok add archive the legacy export tool --tag cleanup --json
ITEM_ARCHIVE="$(last_field data.id)"

expect_ok add wire up the billing webhook --tag billing --json
ITEM_WEBHOOK="$(last_field data.id)"

expect_ok add reindex the search cluster --tag search,infra --json
ITEM_REINDEX="$(last_field data.id)"

expect_ok add rebuild the search cluster config --tag search,infra --json
ITEM_REBUILD="$(last_field data.id)"

expect_ok add groom demo alpha item --tag demo --json
expect_ok add groom demo beta item --tag demo --json

# --- Grooming drafts ---

section "Grooming drafts: export, apply, already_applied, stale_draft"
expect_ok groom export --json
GROOM_EXPORT="$LAST_OUT"
BASE_REV="$(last_field data.baseRevision)"
GROOM_IDS="$(printf '%s' "$GROOM_EXPORT" | bun -e '
  const env = JSON.parse(require("fs").readFileSync(0, "utf8"));
  for (const item of env.data.items.slice(-2)) console.log(item.id);
')"
GROOM_A="$(printf '%s\n' "$GROOM_IDS" | sed -n 1p)"
GROOM_B="$(printf '%s\n' "$GROOM_IDS" | sed -n 2p)"
[[ -n "$GROOM_A" && -n "$GROOM_B" ]] || die "could not find the groom demo item ids in the export"

DRAFT1="$TMP_DIR/draft-1-relate.json"
cat >"$DRAFT1" <<EOF
{
  "version": 1,
  "draftId": "smoke-groom-1",
  "baseRevision": "$BASE_REV",
  "scope": null,
  "summary": "smoke test grooming: update and relate the demo items",
  "operations": [
    { "op": "update-item", "id": "$GROOM_A", "summary": "updated by scripts/smoke.sh" },
    { "op": "add-relation", "kind": "related-to", "from": "$GROOM_A", "to": "$GROOM_B", "note": "smoke test link" }
  ]
}
EOF

expect_ok groom apply "$DRAFT1" --json
assert_contains "$LAST_OUT" '"outcome":"applied"' "the first groom apply"

expect_ok groom apply "$DRAFT1" --json
assert_contains "$LAST_OUT" '"outcome":"already_applied"' "the replayed groom apply"

DRAFT2_STALE="$TMP_DIR/draft-2-stale.json"
cat >"$DRAFT2_STALE" <<EOF
{
  "version": 1,
  "draftId": "smoke-groom-2-stale",
  "baseRevision": "$BASE_REV",
  "scope": null,
  "summary": "smoke test grooming: must be refused, the board has moved on",
  "operations": [
    { "op": "update-item", "id": "$GROOM_A", "summary": "this must never land" }
  ]
}
EOF
expect_fail 1 stale_draft groom apply "$DRAFT2_STALE" --json

expect_ok groom export --json
BASE_REV2="$(last_field data.baseRevision)"
DRAFT3="$TMP_DIR/draft-3-create-close-unrelate.json"
cat >"$DRAFT3" <<EOF
{
  "version": 1,
  "draftId": "smoke-groom-3",
  "baseRevision": "$BASE_REV2",
  "scope": null,
  "summary": "smoke test grooming: create, close, and remove a relation",
  "operations": [
    { "op": "create-item", "tempId": "gamma", "label": "groom demo gamma item", "tags": ["demo"] },
    { "op": "close-item", "id": "$GROOM_B", "state": "cancelled", "reason": "smoke test cleanup" },
    { "op": "remove-relation", "kind": "related-to", "from": "$GROOM_A", "to": "$GROOM_B" }
  ]
}
EOF
expect_ok groom apply "$DRAFT3" --json
[[ "$(last_field data.counts.created)" == "1" ]] || fail_step "expected one item created" "groom apply $DRAFT3"
[[ "$(last_field data.counts.closed)" == "1" ]] || fail_step "expected one item closed" "groom apply $DRAFT3"
[[ "$(last_field data.counts.relationsRemoved)" == "1" ]] ||
  fail_step "expected one relation removed" "groom apply $DRAFT3"

# --- Reading the board ---

section "Reading the board: get, list, search, events, resolve"
expect_ok get "$ITEM_LOGIN" --json
expect_ok get "$ITEM_SEARCH" --json
expect_ok list --state open --json
expect_ok list --tag search --json
expect_ok list --all --jsonl
expect_ok search search --json
expect_ok events "$ITEM_LOGIN" --json
expect_ok resolve search --json
expect_ok ready --json

# --- Claim and release ---

section "Claim and release: already_claimed"
expect_ok claim "$ITEM_ONBOARD" --agent codex --json
expect_fail 1 already_claimed claim "$ITEM_ONBOARD" --agent claude --json
expect_ok claim "$ITEM_ONBOARD" --agent codex --json
assert_contains "$LAST_OUT" '"state":"active"' "the idempotent re-claim"
expect_ok release "$ITEM_ONBOARD" --json

# --- Terminal transitions ---

section "Terminal transitions: done, cancel, supersede, terminal_item"
expect_ok done "$ITEM_RELEASE" --note "shipped v1 notes" --json
expect_fail 1 terminal_item done "$ITEM_RELEASE" --note "again" --json

expect_ok cancel "$ITEM_CACHE" --reason "no longer needed" --json

expect_ok supersede "$ITEM_APIV1" --by "$ITEM_APIV2" --note "v2 replaces v1" --json
expect_fail 1 terminal_item cancel "$ITEM_APIV1" --reason "double cancel" --json

# --- Wait, pause, resume ---

section "Wait, pause, resume"
expect_ok wait "$ITEM_CI" --reason "blocked on a flaky infra ticket" --json
expect_ok resume "$ITEM_CI" --json
expect_ok pause "$ITEM_SETTINGS" --reason "deprioritized this sprint" --json
expect_ok resume "$ITEM_SETTINGS" --json

# --- Order ---

section "Order"
expect_ok order --id "$ITEM_SEARCH" --to first --json
expect_ok order --id "$ITEM_WEBHOOK,$ITEM_REINDEX" --to next --json
expect_ok order --id "$ITEM_ARCHIVE" --to last --json
expect_ok order --id "$ITEM_DASH1" --to after "$ITEM_SEARCH" --json

# "Next" must queue behind *every* claimed item, not just the first: with two
# agents working, the moved run must not jump ahead of the second one. Run on a
# separate board so the ordering is exact rather than dependent on what came
# before it in this transcript.
section "Order: next queues behind two agents' work"
NEXT_DB="$TMP_DIR/next-semantics.sqlite3"
expect_ok add alice work --db "$NEXT_DB" --json
NEXT_ALICE="$(last_field data.id)"
expect_ok add idle between --db "$NEXT_DB" --json
expect_ok add bob work --db "$NEXT_DB" --json
NEXT_BOB="$(last_field data.id)"
expect_ok add later work --db "$NEXT_DB" --json
NEXT_LATER="$(last_field data.id)"
expect_ok claim "$NEXT_ALICE" --agent alice --db "$NEXT_DB" --json
expect_ok claim "$NEXT_BOB" --agent bob --db "$NEXT_DB" --json
expect_ok order --id "$NEXT_LATER" --to next --db "$NEXT_DB" --json
expect_ok list --db "$NEXT_DB" --all --json
NEXT_ORDER="$(printf '%s' "$LAST_OUT" | bun -e "
  const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  process.stdout.write(data.data.items.map((item) => item.label).join(' | '));
")"
assert_contains "$NEXT_ORDER" "alice work | idle between | bob work | later work" \
  "the board order after --to next with two agents working"

# Releasing bob's claim makes his item idle, so next now lands behind alice only.
expect_ok release "$NEXT_BOB" --db "$NEXT_DB" --json
expect_ok order --id "$NEXT_LATER" --to next --db "$NEXT_DB" --json
expect_ok list --db "$NEXT_DB" --all --json
NEXT_ORDER="$(printf '%s' "$LAST_OUT" | bun -e "
  const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  process.stdout.write(data.data.items.map((item) => item.label).join(' | '));
")"
assert_contains "$NEXT_ORDER" "alice work | later work | idle between | bob work" \
  "the board order after --to next with only one agent working"

# --- Edit ---

section "Edit: label, title, summary, existing_topic"
expect_ok edit "$ITEM_ARCHIVE" --summary "superseded by the new exporter" --json
expect_ok edit "$ITEM_ARCHIVE" --title "Archive the legacy exporter" --json
expect_ok edit "$ITEM_ARCHIVE" --label "retire the legacy export tool" --json
assert_contains "$(last_field data.topic_key)" "retire-the-legacy-export-tool" \
  "the topic key after a rename"
# A rename onto a topic another open item already holds is the duplicate `add`
# exists to refuse, so `edit` refuses it the same way.
expect_fail 1 existing_topic edit "$ITEM_ARCHIVE" --label "ship the new onboarding flow" --json
# Terminal items are frozen against edits too.
expect_fail 1 terminal_item edit "$ITEM_RELEASE" --summary "too late" --json
expect_usage_fault edit "$ITEM_ARCHIVE"

# --- Relate and unrelate ---

section "Relate and unrelate: relation_cycle"
expect_ok relate "$ITEM_ONBOARD" contains "$ITEM_SETTINGS" --json
expect_ok relate "$ITEM_REINDEX" depends-on "$ITEM_REBUILD" --note "reindex needs the rebuilt config" --json
expect_ok relate "$ITEM_REINDEX" conflicts-with "$ITEM_WEBHOOK" --json
expect_ok relate "$ITEM_DASH1" related-to "$ITEM_DASH2" --json
expect_fail 1 relation_cycle relate "$ITEM_REBUILD" depends-on "$ITEM_REINDEX" --json
expect_ok unrelate "$ITEM_REINDEX" conflicts-with "$ITEM_WEBHOOK" --json

# --- Link and unlink ---

section "Link and unlink"
expect_ok link "$ITEM_WEBHOOK" --wiki billing-webhook-spec --rel spec --json
expect_ok link "$ITEM_WEBHOOK" --url "https://example.com/billing/webhook-notes" --rel notes --json
expect_ok link "$ITEM_WEBHOOK" --artifact billing-webhook-flow --rel evidence --json
expect_ok unlink "$ITEM_WEBHOOK" --wiki billing-webhook-spec --json

# --- Tree, graph, brief ---

section "Tree, graph, brief"
expect_ok tree --json
expect_ok tree --root "$ITEM_ONBOARD" --json
expect_ok graph --json
expect_ok graph --jsonl
expect_ok brief --json
expect_ok brief --spoken

# --- Remove and restore ---

section "Remove and restore"
expect_ok rm "$ITEM_ARCHIVE" --reason "tool retired" --json
expect_ok restore "$ITEM_ARCHIVE" --reason "still needed after all" --json

# --- Export and import ---

section "Export and import: board_not_empty"
EXPORT_FILE="$TMP_DIR/board-export.jsonl"
expect_ok export --jsonl --out "$EXPORT_FILE"
[[ -s "$EXPORT_FILE" ]] || fail_step "expected a non-empty export file at $EXPORT_FILE" "export --jsonl --out $EXPORT_FILE"

expect_fail 1 board_not_empty import "$EXPORT_FILE" --json

IMPORT_DB="$TMP_DIR/import-target.sqlite3"
expect_ok import "$EXPORT_FILE" --db "$IMPORT_DB" --json
[[ -f "$IMPORT_DB" ]] || fail_step "expected the import target database to exist" "import $EXPORT_FILE --db $IMPORT_DB"
expect_ok list --db "$IMPORT_DB" --all --json

# --- Render and guide ---

section "Render and guide"
RENDER_FILE="$TMP_DIR/board.html"
expect_ok render --out "$RENDER_FILE" --json
[[ -s "$RENDER_FILE" ]] || fail_step "expected a non-empty rendered HTML file at $RENDER_FILE" "render --out $RENDER_FILE"
expect_ok guide --json

# A publish with no --out must leave nothing behind: the snapshot goes through
# a temp file that is removed once the (stubbed) artifact store owns the bytes.
section "Render --publish leaves no file in the cwd"
STUB_BIN="$TMP_DIR/stub-bin"
PUBLISH_CWD="$TMP_DIR/publish-cwd"
mkdir -p "$STUB_BIN" "$PUBLISH_CWD"
# The stub stands in for agentwiki's envelope, which is the actual contract:
# --publish asks for --json and keeps `data` verbatim, so the stub has to emit
# a real schema-v1 envelope and not a line of prose.
cat > "$STUB_BIN/agentwiki" <<'STUB'
#!/bin/sh
printf '%s\n' '{"schema_version":1,"ok":true,"error":null,"data":{"name":"agentboard","version":"0123456789abcdef","kind":"render","status":"created","url":"/a/agentboard/","version_url":"/a/agentboard/v/0123456789abcdef/","stub":"/tmp/wiki/artifacts/agentboard.md"}}'
STUB
chmod +x "$STUB_BIN/agentwiki"
echo "+ agentboard render --publish --json  (cwd: publish-cwd, stub agentwiki)"
PUBLISH_OUT="$(cd "$PUBLISH_CWD" && PATH="$STUB_BIN:$PATH" bun "$MAIN" render --publish --json)"
printf '%s\n' "$PUBLISH_OUT"
printf '%s' "$PUBLISH_OUT" | grep -q '"path":null' ||
    fail_step "expected a null path once the published temp file is removed" "render --publish"
CHECKS=$((CHECKS + 1))
printf '%s' "$PUBLISH_OUT" | grep -q '"version":"0123456789abcdef"' ||
    fail_step "expected agentwiki's envelope data to come through as published" "render --publish"
CHECKS=$((CHECKS + 1))
[[ -z "$(ls -A "$PUBLISH_CWD")" ]] ||
    fail_step "expected render --publish to leave no file in the cwd" "render --publish"
CHECKS=$((CHECKS + 1))

# A refusal on the far side has to arrive as a refusal here, not as success.
section "Render --publish surfaces an agentwiki refusal"
cat > "$STUB_BIN/agentwiki" <<'STUB'
#!/bin/sh
printf '%s\n' '{"schema_version":1,"ok":false,"error":{"code":"artifact_too_large","message":"too big","recovery":"publish fewer bytes"},"data":null}'
exit 1
STUB
chmod +x "$STUB_BIN/agentwiki"
echo "+ agentboard render --publish --json  (stub agentwiki refusing)"
set +e
PUBLISH_FAIL="$(cd "$PUBLISH_CWD" && PATH="$STUB_BIN:$PATH" bun "$MAIN" render --publish --json)"
PUBLISH_FAIL_CODE=$?
set -e
printf '%s\n' "$PUBLISH_FAIL"
[[ "$PUBLISH_FAIL_CODE" -eq 1 ]] ||
    fail_step "expected exit 1 when agentwiki refuses, got $PUBLISH_FAIL_CODE" "render --publish"
CHECKS=$((CHECKS + 1))
printf '%s' "$PUBLISH_FAIL" | grep -q '"code":"publish_failed"' ||
    fail_step "expected a publish_failed envelope when agentwiki refuses" "render --publish"
CHECKS=$((CHECKS + 1))

# --- Ambiguous and unknown refs ---

section "Ambiguous and unknown refs"
expect_fail 1 ambiguous_ref get dashboard --json
expect_fail 1 unknown_ref get "zzz totally nonexistent quux item 424242" --json

# --- Usage fault ---

section "Usage fault: claim with no --agent"
expect_usage_fault claim "$ITEM_ONBOARD"

echo
echo "smoke: $CHECKS checks passed"
