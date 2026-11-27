#!/usr/bin/env bash
# Runs every proof against a throwaway Postgres. Nothing leaves this machine.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
SERVICE_INPUT="${SERVICE_REPO:-$HERE/../support-refunds-service}"
[ -d "$SERVICE_INPUT" ] || { printf 'ERROR  service repo not found at %s\n' "$SERVICE_INPUT" >&2; exit 1; }
SERVICE="$(cd "$SERVICE_INPUT" && pwd -P)"
export SERVICE_REPO="$SERVICE"
PORT="${PGPORT:-55432}"
PGDATA="${PGDATA:-${TMPDIR:-/tmp}/proofline-harness-pg}"
URL="postgres://postgres@127.0.0.1:${PORT}"
PINNED_BASE="e6d5bf20a7ad6550ff062ffbfb6d442ff4b0214f"
PINNED_HEAD="4b99bad15d9428f30f603121d36188e15f8cd464"

PASS=0
FAIL=0
ORIG_REF=""

ok()  { printf 'PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
want() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$3], got [$2])"; fi; }
die() { printf 'ERROR  %s\n' "$1" >&2; exit 1; }

export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres

for tool in git node initdb pg_ctl pg_isready psql createdb dropdb; do
  command -v "$tool" >/dev/null 2>&1 || die "missing $tool. Install Git, Node 22 or newer, and the Postgres 14 server and client tools."
done
[ -d "$SERVICE" ] || die "service repo not found at $SERVICE. Clone support-refunds-service beside this directory, or set SERVICE_REPO."
[ -d "$HERE/node_modules/tsx" ] || die "harness dependencies missing. Run: npm install"
[ -d "$SERVICE/node_modules/pg" ] || die "service dependencies missing. Run: (cd \"$SERVICE\" && npm install)"

git -C "$SERVICE" rev-parse --verify --quiet main >/dev/null || die "no main branch in $SERVICE"

HEAD_REF=""
for candidate in feature/refund-creation origin/feature/refund-creation; do
  if git -C "$SERVICE" rev-parse --verify --quiet "$candidate" >/dev/null; then HEAD_REF="$candidate"; break; fi
done
[ -n "$HEAD_REF" ] || die "no feature/refund-creation branch in $SERVICE"

git -C "$SERVICE" diff --quiet || die "the service working tree has uncommitted changes. Commit or stash them first."
git -C "$SERVICE" diff --cached --quiet || die "the service index has staged changes. Commit or stash them first."

BASE_SHA="$(git -C "$SERVICE" rev-parse main)"
HEAD_SHA="$(git -C "$SERVICE" rev-parse "$HEAD_REF")"
printf 'service   %s\n' "$SERVICE"
printf 'base      main %s\n' "${BASE_SHA:0:12}"
printf 'head      %s %s\n' "$HEAD_REF" "${HEAD_SHA:0:12}"
[ "$BASE_SHA" = "$PINNED_BASE" ] || printf 'WARN  main is not the pinned commit (%s)\n' "${PINNED_BASE:0:12}"
[ "$HEAD_SHA" = "$PINNED_HEAD" ] || printf 'WARN  head is not the pinned commit (%s)\n' "${PINNED_HEAD:0:12}"

if pg_isready -q -h 127.0.0.1 -p "$PORT"; then
  die "something is already listening on 127.0.0.1:$PORT. Set PGPORT to a free port."
fi

ORIG_REF="$(git -C "$SERVICE" symbolic-ref --quiet --short HEAD || git -C "$SERVICE" rev-parse HEAD)"
git -C "$SERVICE" checkout --quiet --detach "$HEAD_REF" || die "could not check out $HEAD_REF"

cleanup() {
  pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1
  if [ "${KEEP_PG:-0}" != "1" ]; then rm -rf "$PGDATA"; else printf '\nkept database cluster at %s\n' "$PGDATA"; fi
  if [ -n "$ORIG_REF" ]; then git -C "$SERVICE" checkout --quiet "$ORIG_REF" >/dev/null 2>&1; fi
}
trap cleanup EXIT

rm -rf "$PGDATA"
initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null || die "initdb failed"
pg_ctl -D "$PGDATA" -o "-p $PORT -c listen_addresses=127.0.0.1" -l "$PGDATA/server.log" -w start >/dev/null || die "pg_ctl start failed"
printf 'database  temporary cluster on port %s\n\n' "$PORT"

for db in proof_main proof_branch proof_s1fail; do
  dropdb --if-exists "$db" >/dev/null 2>&1
  createdb "$db"
done

printf '%s\n' '--- schema and migration proofs ---'

git -C "$SERVICE" show main:migrations/001_init.sql | psql -q -v ON_ERROR_STOP=1 -d proof_main >/dev/null
psql -q -v ON_ERROR_STOP=1 -d proof_main -c "
  INSERT INTO customers (id,email) VALUES ('11111111-1111-4111-8111-111111111111','a@example.test');
  INSERT INTO orders (id,customer_id,amount) VALUES ('aaaaaaaa-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111',4200);
  INSERT INTO refunds (id,order_id,customer_id,amount,reason) VALUES
    ('cccccccc-1111-4111-8111-111111111111','aaaaaaaa-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111',4200,'test');" >/dev/null

want "baseline query reads refunds.amount" \
  "$(psql -d proof_main -tAc "SELECT amount FROM refunds")" "4200"

DATABASE_URL="$URL/proof_branch" node --import tsx "$SERVICE/scripts/migrate.ts" >/dev/null 2>&1
want "branch applies all three migrations" \
  "$(psql -d proof_branch -tAc "SELECT count(*) FROM schema_migrations")" "3"

psql -q -v ON_ERROR_STOP=1 -d proof_branch -c "
  INSERT INTO customers (id,email) VALUES ('11111111-1111-4111-8111-111111111111','a@example.test');
  INSERT INTO orders (id,customer_id,amount) VALUES ('aaaaaaaa-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111',4200);
  INSERT INTO refunds (order_id,customer_id,amount_cents,reason)
    SELECT 'aaaaaaaa-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111',4200,'bulk '||g
      FROM generate_series(1,5000) g;
  ANALYZE refunds;" >/dev/null

OLD_ERR="$(psql -d proof_branch -tAc "SELECT id, order_id, amount, currency FROM refunds LIMIT 1" 2>&1)"
case "$OLD_ERR" in
  *'column "amount" does not exist'*) ok "P3 the previous revision's query fails after the rename" ;;
  *) bad "P3 the old query did not fail as expected: $OLD_ERR" ;;
esac

want "S1 the new index is valid" \
  "$(psql -d proof_branch -tAc "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.refunds_customer_created_idx')")" "t"
want "S1 the old index is gone" \
  "$(psql -d proof_branch -tAc "SELECT count(*) FROM pg_indexes WHERE tablename='refunds' AND indexname='refunds_customer_idx'")" "0"
PLAN="$(psql -d proof_branch -tAc "EXPLAIN SELECT id FROM refunds WHERE customer_id='11111111-1111-4111-8111-111111111111' ORDER BY created_at DESC LIMIT 5")"
case "$PLAN" in
  *refunds_customer_created_idx*) ok "S1 the refund list uses the new index" ;;
  *) bad "S1 the refund list does not use the new index" ;;
esac

git -C "$SERVICE" show main:migrations/001_init.sql | psql -q -v ON_ERROR_STOP=1 -d proof_s1fail >/dev/null
psql -q -v ON_ERROR_STOP=1 -d proof_s1fail -c "
  CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
  INSERT INTO schema_migrations (version) VALUES ('001_init.sql');
  INSERT INTO customers (id,email) VALUES ('11111111-1111-4111-8111-111111111111','a@example.test');
  INSERT INTO orders (id,customer_id,amount) VALUES ('aaaaaaaa-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111',4200);
  INSERT INTO refunds (order_id,customer_id,amount,created_at) VALUES
    ('aaaaaaaa-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111',100,'2026-10-01T10:00:00Z'),
    ('aaaaaaaa-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111',200,'2026-10-01T10:00:00Z');" >/dev/null
psql -d proof_s1fail -c "CREATE UNIQUE INDEX CONCURRENTLY refunds_customer_created_idx ON refunds (customer_id, created_at);" >/dev/null 2>&1
want "S1 a failed build leaves an invalid index" \
  "$(psql -d proof_s1fail -tAc "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.refunds_customer_created_idx')")" "f"

DATABASE_URL="$URL/proof_s1fail" node --import tsx "$SERVICE/scripts/migrate.ts" >/dev/null 2>&1
want "S1 the old index survives an invalid replacement" \
  "$(psql -d proof_s1fail -tAc "SELECT count(*) FROM pg_indexes WHERE tablename='refunds' AND indexname='refunds_customer_idx'")" "1"
want "S1 the failed migration is not recorded" \
  "$(psql -d proof_s1fail -tAc "SELECT count(*) FROM schema_migrations")" "1"

printf '\n%s\n' '--- code proofs ---'
cd "$HERE" || die "cannot enter $HERE"
node --import tsx "$HERE/check-p1.ts" || FAIL=$((FAIL+1))
printf '\n'
node --import tsx "$HERE/check-static.ts" 2>/dev/null || FAIL=$((FAIL+1))
printf '\n'
node --import tsx "$HERE/check-p2p4.ts" 2>/dev/null | grep -vE '"level":"(info|warn)"' || FAIL=$((FAIL+1))
printf '\n'
node --import tsx "$HERE/check-p5.ts" 2>/dev/null | grep -vE '"level":"info"' || FAIL=$((FAIL+1))
printf '\n'
DATABASE_URL="$URL/proof_branch" node --import tsx "$HERE/check-s2.ts" || FAIL=$((FAIL+1))
printf '\n'
DATABASE_URL="$URL/proof_branch" node --import tsx "$HERE/check-review-s2.ts" || FAIL=$((FAIL+1))

printf '\ndatabase checks: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
