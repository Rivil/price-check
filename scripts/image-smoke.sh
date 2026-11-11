#!/usr/bin/env bash
# Production-image smoke check, run on the host (it needs Docker itself, so it is
# not part of `pnpm test`, which runs inside the dev container):
#
#   scripts/image-smoke.sh
#
# Builds the runtime image, boots it on a fresh volume and checks that a brand-new
# install works end to end: migrations ran at startup, /health answers, the first
# admin can be created inside the container, that admin can sign in and the
# watchlist renders. First, it checks the image refuses to start without
# ALERTS_ENCRYPTION_KEY and says so.
# The auth secret, alerts key and admin password are generated into a temp dir and only ever
# move file-to-file (env file, stdin, curl @file) — never argv, never output.
# Nothing here reaches a shop site: the database starts empty, so the scheduler
# has nothing to check.
set -euo pipefail

PORT="${SMOKE_PORT:-3999}"
TAG="price-check-app:smoke-$$"
NAME="apc-smoke-$$"
VOLUME="apc-smoke-data-$$"
BASE="http://localhost:${PORT}"
PUBLIC="https://localhost:${PORT}"
EMAIL="smoke-admin@example.test"
WORK="$(mktemp -d)"

cleanup() {
	docker rm -fv "$NAME-nokey" >/dev/null 2>&1 || true
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	docker volume rm "$VOLUME" >/dev/null 2>&1 || true
	docker rmi "$TAG" >/dev/null 2>&1 || true
	rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
	echo "image-smoke: FAIL: $*" >&2
	exit 1
}

cd "$(dirname "$0")/.."

echo "image-smoke: building runtime image"
docker build --quiet --target runtime -t "$TAG" . >/dev/null

{
	printf 'BETTER_AUTH_SECRET='
	openssl rand -hex 32
	# Production runs behind a TLS proxy (see Dockerfile); the requests below
	# simulate it with X-Forwarded-Proto, so the public origin is https.
	printf 'ORIGIN=%s\n' "$PUBLIC"
} >"$WORK/env-nokey"
{
	cat "$WORK/env-nokey"
	printf 'ALERTS_ENCRYPTION_KEY='
	openssl rand -base64 32
} >"$WORK/env"
openssl rand -hex 16 | tr -d '\n' >"$WORK/password"

# Without the key the server must exit at startup, naming the variable (decision
# encryption_key) — a half-working alerts page is worse than no start.
echo "image-smoke: starting without ALERTS_ENCRYPTION_KEY (must refuse)"
docker run -d --name "$NAME-nokey" --env-file "$WORK/env-nokey" "$TAG" >/dev/null
running="true"
for _ in $(seq 1 30); do
	running="$(docker inspect -f '{{.State.Running}}' "$NAME-nokey" 2>/dev/null || echo gone)"
	[ "$running" = "true" ] || break
	sleep 1
done
[ "$running" = "false" ] || fail "server without ALERTS_ENCRYPTION_KEY still running after 30s"
docker logs "$NAME-nokey" >"$WORK/nokey-logs" 2>&1
grep -q 'ALERTS_ENCRYPTION_KEY' "$WORK/nokey-logs" ||
	fail "server without the key exited but its logs do not name ALERTS_ENCRYPTION_KEY"
docker rm -fv "$NAME-nokey" >/dev/null 2>&1 || true
echo "image-smoke: refused to start without ALERTS_ENCRYPTION_KEY"

echo "image-smoke: starting on a fresh volume"
docker run -d --name "$NAME" --env-file "$WORK/env" -p "${PORT}:3000" \
	-v "${VOLUME}:/data" "$TAG" >/dev/null

status=""
for _ in $(seq 1 30); do
	status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/login" || true)"
	[ "$status" = "200" ] && break
	sleep 1
done
[ "$status" = "200" ] || fail "/login answered '${status}' after 30s"
echo "image-smoke: /login 200"

# Before admin-create (which migrates on its own): the server must have done it.
tables="$(docker exec "$NAME" node --input-type=module -e "
import { createClient } from '@libsql/client';
const c = createClient({ url: process.env.DATABASE_URL });
const r = await c.execute(\"select name from sqlite_master where type = 'table' and name in ('user', 'watch', 'price_point', 'alert_channel')\");
console.log(r.rows.length);
c.close();
")"
[ "$tables" = "4" ] || fail "server did not migrate at startup (${tables} of 4 app tables present)"
echo "image-smoke: migrated at startup"

# Also before admin-create, for the same reason: it would hide an unmigrated server.
health="$(curl -s -o "$WORK/health" -w '%{http_code}' --max-time 5 "$BASE/health" || true)"
[ "$health" = "200" ] || fail "/health answered '${health}', expected 200"
[ "$(cat "$WORK/health")" = '{"status":"ok"}' ] || fail "/health answered 200 with the wrong body"
echo "image-smoke: /health 200"

echo "image-smoke: creating the first admin inside the container"
{
	printf '%s\n%s\n' "$EMAIL" "Smoke Admin"
	cat "$WORK/password"
	printf '\n'
} >"$WORK/admin-answers"
docker exec -i "$NAME" node src/lib/server/cli/admin-create.ts <"$WORK/admin-answers" \
	>"$WORK/admin-out" 2>&1 || fail "admin-create exited non-zero: $(tail -n 1 "$WORK/admin-out")"
grep -q "created admin ${EMAIL}" "$WORK/admin-out" || fail "admin-create did not report the admin"
echo "image-smoke: admin created"

echo "image-smoke: signing in"
login="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 \
	-c "$WORK/cookies" -H "Origin: $PUBLIC" -H 'X-Forwarded-Proto: https' -H 'Accept: text/html' \
	--data-urlencode "email=${EMAIL}" --data-urlencode "password@${WORK}/password" \
	"$BASE/login")"
[ "$login" = "303 ${BASE}/" ] || fail "sign-in answered '${login}', expected '303 ${BASE}/'"

home="$(curl -s -o "$WORK/home.html" -w '%{http_code}' --max-time 10 -b "$WORK/cookies" \
	-H 'X-Forwarded-Proto: https' "$BASE/")"
[ "$home" = "200" ] || fail "watchlist answered ${home} when signed in"
echo "image-smoke: signed in, watchlist 200"

docker logs "$NAME" >"$WORK/logs" 2>&1
if grep -qE 'no such table|pass failed|Error' "$WORK/logs"; then
	grep -E 'no such table|pass failed|Error' "$WORK/logs" | head -n 5 | cut -c1-200 >&2
	fail "server logged errors"
fi

echo "image-smoke: PASS"
