# 02-single-user: verification-lens draft

Method: I wrote each criterion's ideal test contract first (see "Contracts first" below) and then derived the smallest task that can make that contract pass. The black-box contracts for c-1, c-2, c-5, c-6 and c-7 run against `node build` (adapter-node, the runtime Electron will host). They do not run against `vite preview`, for two reasons:

- Vite preview has its own `preview.allowedHosts` check, so a Host test against it passes even with no hook.
- Playwright's `webServer.env` is merged over `process.env`, so a "server starts with only two vars" test can't prove that through the shared preview server.

Legend: `(new)` = file created, `(del)` = file deleted. Every other path exists today.

## Contracts first (criterion → ideal test)

| id | Ideal contract (the test that fails if the criterion breaks) |
|---|---|
| c-1 | `e2e/fresh-install.e2e.ts` spawns `node build` on an empty DB file. `GET /` returns 200 and `response.request().redirectedFrom()` is null. The final pathname is `/`, the empty-watchlist text is visible, and there are 0 `input[type=password]`. Unit backstop: `load()` in `src/routes/+page.server.ts` with `locals = {}` on a fresh test DB returns `{ watches: [] }` instead of throwing 401. |
| c-2 | Same spawned server. The env is built from an allowlist (`PATH`/`SystemRoot`/`HOME` + `PORT`/`HOST` + `DATABASE_URL` + `ALERTS_ENCRYPTION_KEY`), and `BETTER_AUTH_SECRET` and `ORIGIN` are explicitly absent. `/`, `/account/alerts`, `/health` and `/watches/<inserted id>` each return 200. `env.spec`: the declared vars are exactly `ALERTS_ENCRYPTION_KEY, CHECK_INTERVAL_HOURS, DATABASE_URL, SCHEDULER_DISABLED`, and every one except `DATABASE_URL` validates `undefined`. |
| c-3 | `src/routes/removed-routes.e2e.ts` uses `maxRedirects: 0`. `GET` on `/login`, `/logout`, `/account/password`, `/admin/users`, `/admin/users/x/password`, `/api/auth/get-session` and `/api/auth/session`, plus same-origin `POST` on `/logout` and `/api/auth/sign-in/email`, all return exactly 404. A 303 to `/` fails the test (this is the removed_routes decision). |
| c-4 | `header.e2e.ts` visits `/`, `/watches/<seeded>`, `/account/alerts` and `/no-such-page` (the 404 error page). On each it checks that there are 0 `button` named /sign out/i, 0 links named Admin or Account, and exactly one footer link named `Source` with href `===` `https://github.com/Rivil/price-check`. Every header nav href also has to GET 200. |
| c-5 | `e2e/restart.e2e.ts` starts server A, inserts a watch and two price points into the same file through `createDb`, saves an ntfy channel through a form POST to `/account/alerts?/save`, then stops A. It starts server B on the same file and checks that `/` lists the watch, `/watches/<id>` shows both prices, and `/account/alerts` shows the saved topic, which means the channel config was decrypted. |
| c-6 | `e2e/local-guard.e2e.ts` iterates `e2e/actions.ts` (an inventory of every `[path, action]`). For each one it sends a form POST with `Origin: https://evil.example`, expects 403, and checks the DB row is unchanged (the watch still exists after `?/delete`). `src/routes/actions-inventory.spec.ts` fails if any `+page.server.ts` exports an action key that is missing from the inventory. |
| c-7 | `local-guard.spec.ts` covers the pure function with a table of accepted/rejected Host values. `hooks.server.spec.ts` checks the exported `handle` returns 403 on `/health` with `Host: evil.example` without calling `resolve`. `local-guard.e2e.ts` sends raw `node:http` requests with an overridden Host to `node build`, covering `/`, `/health` and `/account/alerts`, and expects 403. |

## Plan

```
Phase 02-single-user — 17 tasks across 7 waves

Wave 1
  t-1  Rebaseline migrations without auth tables
       files:    src/lib/server/db/schema.ts, src/lib/server/db/watch.schema.ts,
                 src/lib/server/db/channel.schema.ts, src/lib/server/db/auth.schema.ts (del),
                 src/lib/server/db/alert.schema.ts (del), drizzle/0000..0008 + meta (del),
                 drizzle/0000_install_baseline.sql (new), drizzle/meta/0000_snapshot.json (new),
                 drizzle/meta/_journal.json, src/lib/server/testing/test-db.ts (new),
                 src/lib/server/db/migrate.spec.ts
       does:     Drop user/session/account/verification/alert_channel and every user_id column/index;
                 watch unique on (shop, product_id); notify_channel PK = kind; price_drop_delivery
                 FK (kind) → notify_channel. One regenerated baseline migration. test-db.ts =
                 migrated temp-file DB + cleanup (MIGRATIONS_FOLDER moves here).
       covers:   c-5
       contract: migrate.spec 'install-owned schema': empty DB → sqlite_master tables exactly
                 [check_failure, notify_channel, price_drop_delivery, price_point, watch]; PRAGMA
                 table_info on every table has no user_id column and PRAGMA index_list/index_info has
                 no index over user_id — a leftover user_id anywhere fails it.
                 migrate.spec 'idempotent restart': rows inserted after the first migrateDb survive a
                 second migrateDb on a NEW client for the same file, and __drizzle_migrations count is
                 unchanged — a migration that recreates/drops tables fails it.
                 migrate.spec 'schema matches baseline': for every sqliteTable exported by schema.ts,
                 getTableConfig column names === PRAGMA table_info names — snapshot/schema drift fails it.

  t-2  Add loopback Host guard module
       files:    src/lib/server/local-guard.ts (new), src/lib/server/local-guard.spec.ts (new)
       does:     isLoopbackHost(host: string | null) + createLocalRequestHandle(): reads the raw
                 request Host header, 403s anything not localhost / 127.0.0.1 with optional port.
       covers:   c-7
       contract: accepts 'localhost', 'localhost:5173', '127.0.0.1', '127.0.0.1:65535', 'LOCALHOST:80';
                 rejects 'evil.example', 'evil.example:4173', 'localhost.evil.example',
                 '127.0.0.1.nip.io', '127.0.0.2', '0.0.0.0', '[::1]:4173', 'localhost:', 'localhost:x',
                 '', null — a startsWith/includes implementation fails the look-alike rows.
                 handle test: event.url = http://localhost/ (as ORIGIN would set it) but Host header
                 'evil.example' → 403 and resolve not called — reading event.url.host instead of the
                 header fails it; '/health' with a foreign Host → 403 (no exemption).

  t-3  Trim header nav, add Source footer
       files:    src/lib/nav.ts, src/lib/nav.spec.ts, src/routes/+layout.svelte,
                 src/lib/components/SiteFooter.svelte (new),
                 src/lib/components/SiteFooter.svelte.spec.ts (new)
       does:     navItems({ pathname }) → Watchlist, Alerts only (no isAdmin, no Account); header
                 always rendered, Sign out form removed; SiteFooter rendered unconditionally outside
                 any {#if} so error pages get it too.
       covers:   c-4
       contract: nav.spec: navItems({pathname:'/'}).map(i => i.href) toEqual ['/', '/account/alerts']
                 — re-adding Admin/Account fails it. SiteFooter.svelte.spec (browser): exactly one
                 link with accessible name 'Source' and href === 'https://github.com/Rivil/price-check'
                 (a trailing slash, .git or http:// fails it) inside a contentinfo landmark.

Wave 2
  t-4  Unscope watch and check domain functions   (depends t-1)
       files:    src/lib/server/watches.ts, src/lib/server/watches.spec.ts,
                 src/lib/server/checks.ts, src/lib/server/checks.spec.ts
       does:     Drop the userId parameter from addWatch/listWatches/getWatch/setTarget/deleteWatch/
                 findOwn/checkNow/priceHistory/failureHistory; specs move to test-db.ts.
       covers:   c-1, c-5
       contract: watches.spec 'one watch per product': adding the same ASIN twice returns the
                 existing watch and `select count(*) from watch` stays 1 — dedupe keyed on anything
                 but (shop, product_id) fails it. listWatches(db) on a fresh DB returns []. getWatch /
                 priceHistory / failureHistory of an unknown id → null / [] / []. checkNow cooldown
                 refusal unchanged.

  t-5  Unscope sparklines, move scheduler/health specs   (depends t-1)
       files:    src/lib/server/sparklines.ts, src/lib/server/sparklines.spec.ts,
                 src/lib/server/scheduler.spec.ts, src/lib/server/health.spec.ts
       does:     recentPrices(db, now) over all watches; scheduler/health specs build on test-db.ts.
       covers:   c-1
       contract: sparklines.spec: points from two different watches both appear in the returned
                 map and points older than 30 days are excluded — a leftover user join fails it;
                 health.spec still 503s on a closed client.

  t-6  Key channels and AAD by kind only   (depends t-1)
       files:    src/lib/server/alerts/channels.ts, src/lib/server/alerts/crypto.ts,
                 src/lib/server/alerts/channels.spec.ts, src/lib/server/alerts/crypto.spec.ts
       does:     channelAad(kind); listChannels/channelsFor/loadChannelConfig/saveChannel/setEnabled/
                 removeChannel lose userId.
       covers:   c-5
       contract: crypto.spec: channelAad('ntfy') === '["alert-channel","ntfy"]' (pinned literal — any
                 per-run/per-install component fails it); a blob sealed for 'ntfy' fails to open as
                 'resend'. channels.spec 'survives a new client': saveChannel on client A, close,
                 listChannels on client B over the same file with the same key returns the topic —
                 fails if AAD or key derivation varies per process. Two saves of 'ntfy' leave one row.

  t-7  Rewire hooks: loopback guard, no auth   (depends t-1, t-2)
       files:    src/hooks.server.ts, src/hooks.server.spec.ts, src/lib/server/access.ts (del),
                 src/lib/server/access.spec.ts (del), src/lib/server/alerts/backfill.ts (del),
                 src/lib/server/alerts/backfill.spec.ts (del)
       does:     handle = sequence(localRequestGuard) — no session load, no svelteKitHandler; init:
                 key → migrate → scheduler (legacy alert_channel backfill gone with its table).
       covers:   c-1, c-7
       contract: hooks.server.spec 'guard is first': exported handle on '/health' with Host
                 'evil.example' → 403, resolve never called; on '/' with Host 'localhost:4173' →
                 resolve called once, no redirect thrown — a surviving /login redirect fails it.
                 'init order' toEqual ['key', 'migrated', 'scheduler']; spec has no better-auth mock,
                 so a remaining #lib/server/auth.ts import fails module load.

Wave 3
  t-8  Route alerts to install channels   (depends t-4, t-6)
       files:    src/lib/server/alerts/alerts.ts, src/lib/server/alerts/alerts.spec.ts,
                 src/lib/server/alerts/live.spec.ts
       does:     alertAfterSuccess/alertAfterFailure call channelsFor(db, key, purpose) with no owner;
                 price_drop_delivery rows keyed (watch_id, kind).
       covers:   c-5
       contract: alerts.spec: an enabled ntfy channel receives exactly one drop alert for a watch
                 at target and a price_drop_delivery row (watch, 'ntfy', target) exists; a second
                 success at the same target sends nothing; disabling the channel → zero sends;
                 deleting the channel cascades its delivery rows.

  t-9  Drop user scoping from watchlist and watch page   (depends t-4, t-5)
       files:    src/routes/+page.server.ts, src/routes/page.server.spec.ts,
                 src/routes/watches/[id]/+page.server.ts, src/routes/watches/[id]/page.server.spec.ts
       does:     Remove every locals.user guard / 401; call the unscoped domain functions.
       covers:   c-1
       contract: page.server.spec 'fresh install': load({ locals: {} }) on a fresh test DB resolves
                 { watches: [] } — any remaining `error(401)` fails it; ?/add with a fake shop then
                 load lists it. watches/[id] spec: load with locals {} on a seeded id → watch view;
                 unknown id → 404; ?/delete then load → 404.

  t-10 Drop user scoping from alerts page   (depends t-6)
       files:    src/routes/account/alerts/+page.server.ts,
                 src/routes/account/alerts/page.server.spec.ts
       does:     No signedIn(locals); loginEmail removed (new email cards start with an empty
                 recipient).
       covers:   c-1, c-5
       contract: load({ locals: {} }) → three null cards, no 401; ?/save ntfy then load returns the
                 topic; returned data has no loginEmail key — the old prefill path fails it.

Wave 4
  t-11 Delete auth routes, modules and locals   (depends t-7, t-9, t-10)
       files:    src/routes/login/** (del), src/routes/logout/** (del),
                 src/routes/account/password/** (del), src/routes/admin/** (del),
                 src/routes/+layout.server.ts (del), src/routes/layout.server.spec.ts (del),
                 src/lib/server/{auth,auth-factory,accounts,admin-bootstrap,login-limiter,own-password}.ts
                 + their .spec.ts (del), src/lib/server/cli/admin-create.ts (del),
                 src/lib/server/testing/auth-harness.ts (del), src/app.d.ts,
                 src/routes/no-public-signup.spec.ts (del), src/routes/no-auth.spec.ts (new)
       does:     Pure deletion plus the Locals type emptied; the guard spec replaces no-public-signup.
       covers:   c-3
       contract: no-auth.spec: existsSync false for src/routes/{login,logout,account/password,admin};
                 no non-test file under src/ (import.meta.glob ?raw) matches /better-auth|locals\.user|
                 \/api\/auth/ — a resurrected route or import fails it.

Wave 5
  t-12 Remove better-auth dependency and secret var   (depends t-11)
       files:    src/env.ts, src/env.spec.ts, package.json, pnpm-lock.yaml, .env.example,
                 README.md, scripts/readme.spec.ts
       does:     Drop BETTER_AUTH_SECRET and ORIGIN declarations (nothing in src reads ORIGIN after
                 auth; adapter-node reads process.env.ORIGIN itself); drop better-auth + auth deps,
                 admin:create and auth:schema scripts; README dev steps lose the secret/admin step.
       covers:   c-2
       contract: env.spec: Object.keys(variables).sort() toEqual [ALERTS_ENCRYPTION_KEY,
                 CHECK_INTERVAL_HOURS, DATABASE_URL, SCHEDULER_DISABLED] and every key except
                 DATABASE_URL validates undefined → { value: undefined } — re-adding a required var
                 fails it. readme.spec: package.json deps/devDeps have no 'better-auth'/'auth', scripts
                 have no admin:create/auth:schema, README and .env.example never mention
                 BETTER_AUTH_SECRET or admin:create.

Wave 6
  t-13 Reseed e2e as one install, add node-server helper   (depends t-12)
       files:    e2e/accounts.ts, e2e/seed.ts, e2e/harness.e2e.ts, playwright.config.ts,
                 e2e/node-server.ts (new)
       does:     Seed writes watches/points/failures with no owner (otherPriced and all SEEDED_<user>
                 credentials/signIn helpers removed) and saves the design ntfy channel via
                 saveChannel with E2E_ALERTS_KEY; webServer env loses BETTER_AUTH_SECRET.
                 node-server.ts: startNodeServer({ port, dbFile, env }) spawns `node build` with an
                 allowlisted env (never process.env spread), waits for /health, stop() kills and
                 awaits exit (libsql releases the file on win32).
       covers:   c-1, c-2
       contract: harness.e2e 'fresh seed': every SEEDED_WATCHES id present, no table named user,
                 notify_channel has exactly one 'ntfy' row and loadChannelConfig opens it with
                 E2E_ALERTS_KEY; 'webServer env' asserts test.info().config.webServer env has no
                 BETTER_AUTH_SECRET key. harness.e2e 'node-server env': the spawned child's env
                 (echoed via a test-only probe script, not the app) contains no BETTER_AUTH_SECRET or
                 ORIGIN unless passed — a process.env spread fails it.

Wave 7
  t-14 Strip sign-in from page-flow e2e specs   (depends t-13)
       files:    src/routes/watchlist.e2e.ts, src/routes/watches/[id]/watch-page.e2e.ts,
                 src/routes/account/alerts/alerts.e2e.ts, src/routes/at-target.e2e.ts,
                 src/routes/chart-a11y.e2e.ts, src/routes/page.svelte.e2e.ts (del)
       does:     page.goto directly; cross-user tests deleted; counts/ordering re-based on the merged
                 single watchlist.
       covers:   c-1
       contract: watchlist.e2e 'opens without login': response of page.goto('/') is 200 with no
                 redirectedFrom, h1 'Watchlist' visible and every seeded title (formerly split
                 across member/design) listed — a redirect or a leftover owner filter fails it.

  t-15 Re-base chrome, focus and contrast e2e   (depends t-13, t-3)
       files:    src/routes/header.e2e.ts, src/routes/layout.e2e.ts, src/routes/focus.e2e.ts,
                 src/routes/contrast.e2e.ts, src/routes/health/health.e2e.ts
       does:     Page lists become '/', watch page, '/account/alerts', a 404 page; login/admin/
                 password rows deleted; footer link joins focus-order and contrast checks.
       covers:   c-4
       contract: header.e2e 'chrome on every page' (the c-4 ideal contract above, including the 404
                 page and nav-href → 200). health.e2e 'exact path': '/healthx' → 404 (was 303 to
                 /login) — any surviving redirect fails it. contrast.e2e passes with the footer link
                 in both colour schemes.

  t-16 Add fresh-install and restart e2e   (depends t-13)
       files:    e2e/fresh-install.e2e.ts (new), e2e/restart.e2e.ts (new)
       does:     Both spawn node build via node-server.ts on their own temp DB file and port.
                 Inserted watches get lastCheckedAt = now + 1 day so the scheduler never fetches
                 (r-01); restart passes ORIGIN only so its same-origin save POST clears Kit's CSRF.
       covers:   c-1, c-2, c-5
       contract: the c-1, c-2 and c-5 ideal contracts above, verbatim.

  t-17 Add removed-route, CSRF and Host e2e   (depends t-13)
       files:    src/routes/removed-routes.e2e.ts (new), e2e/local-guard.e2e.ts (new),
                 e2e/actions.ts (new), src/routes/actions-inventory.spec.ts (new)
       does:     removed-routes runs on the preview server; local-guard spawns node build (vite
                 preview's allowedHosts would mask a missing hook); actions.ts lists every
                 [path, action].
       covers:   c-3, c-6, c-7
       contract: the c-3, c-6 and c-7 ideal contracts above. actions-inventory.spec: action keys
                 parsed from every src/routes/**/+page.server.ts `export const actions` (?raw glob)
                 toEqual the e2e/actions.ts inventory — a new action without a CSRF row fails it.
```

## Coverage

| criterion | tasks |
|---|---|
| c-1 | t-4, t-5, t-7, t-9, t-10, t-13, t-14, **t-16** |
| c-2 | **t-12**, t-13, **t-16** |
| c-3 | **t-11**, **t-17** |
| c-4 | **t-3**, **t-15** |
| c-5 | **t-1**, t-4, **t-6**, t-8, t-10, **t-16** |
| c-6 | **t-17** |
| c-7 | **t-2**, **t-7**, **t-17** |

Bold marks the task that owns the criterion's authoritative contract. 7/7 criteria are covered.

## Judgment calls

- **Real servers for c-1, c-2, c-5, c-7:** these contracts spawn `node build` per test through `e2e/node-server.ts`. I rejected a second Playwright `webServer` entry and vitest-only coverage. Playwright merges `process.env` into webServer env, so the run can't prove "only two vars". Vite preview's `allowedHosts` would make a Host test pass with no hook. Only a real process restart proves c-5.
- **Migrations:** I squash 0000–0008 into one regenerated baseline. I rejected an additive 0009 that drops the tables. data_scope locks "no installs exist, old-server import is a non-goal", so upgrade paths and the 0007 upgrade test protect nothing. An additive drop would mean SQLite table rebuilds through FK chains just to delete them again.
- **Legacy alert_channel:** I delete the table and `backfill.ts` along with the rest of the auth schema. I rejected keeping the backfill: it only existed to migrate server-era plaintext rows, and data_scope forbids user-keyed tables.
- **Channel AAD:** I change it to `['alert-channel', kind]`, pinned as a literal in a test. I rejected a per-install id in the AAD: it adds state that must survive restarts (a c-5 risk) and buys nothing for a single-key, single-owner DB.
- **ORIGIN:** I drop it from `env.ts` rather than keep it as an optional declaration. After auth is gone nothing in `src/` reads it, and adapter-node reads `process.env.ORIGIN` directly.
- **Flag for 03-desktop-shell:** with ORIGIN unset, adapter-node assumes `https`. Every same-origin form POST then fails Kit's CSRF check, so Electron must set `ORIGIN=http://127.0.0.1:<port>`. The restart test sets ORIGIN only because it POSTs. The c-2 test (GETs only) does not set it.
- **IPv6 loopback:** `[::1]` is rejected. c-7 names only localhost and 127.0.0.1, and 03 binds 127.0.0.1. Host matching is case-insensitive on the hostname.
- **Footer:** extracted to a `SiteFooter.svelte` component with a browser spec. I rejected testing it only through a `+layout.svelte` render, which would need `$app/state`/`$app/paths` mocks. "Every page", including the 404 page, is proven in e2e (t-15).
- **c-6 action list:** CSRF coverage is enumerated through an `e2e/actions.ts` inventory that a vitest spec checks against the `+page.server.ts` sources. I rejected testing a single action: Kit's check is global, but "any action" only holds if a new action can't be added without a test row.
- **Alerts page prefill:** the email recipient prefill (the old `loginEmail`) is removed and starts empty. I rejected adding a settings row for an email: there is no user, and the spec doesn't ask for one.
- **Red full suite between waves:** I accepted that the full suite is red between waves 1 and 6, and gated each task on its own named specs. I rejected compatibility shims (for example a phantom `userId` parameter) that would keep old tests green; they would leave the auth shape half alive, which is the opposite of data_scope.
- **Splits:** I split deletion (t-11) from dependency/env removal (t-12). `env.ts` can only drop `BETTER_AUTH_SECRET` once `auth.ts` is gone. A separate t-12 also gives the c-2 static contract its own gate.
- **ARCHITECTURE.md:** no task here. It is regenerated by `/dross-architecture` after the phase, since its debt is already deferred.
