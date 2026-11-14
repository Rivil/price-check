# Planner draft — RISK lens

Failure modes drive the graph. Every risk in the register below has exactly one
owning task, and that task's test_contract is the test that catches it. Tasks are
split along risk boundaries first and layer boundaries second.

## Risk register (risk → single owner)

| # | Failure mode | Owner |
|---|---|---|
| R1 | 0009 table rebuild (`DROP TABLE watch`) cascades away price_point / check_failure / delivery rows on upgrade | t-2 |
| R2 | Two-user DB collides on the new `(shop, product_id)` / `notify_channel(kind)` keys and leaves a half-migrated DB | t-2 |
| R3 | 0009 journal `when` ≤ 0008's → drizzle's libsql migrator silently skips it on existing DBs | t-2 |
| R4 | Legacy `notify_channel` rows with `config_enc IS NULL` are stranded once `alert_channel` + backfill are gone | t-2 |
| R5 | Rebuilt fresh schema loses its FKs/uniques (cascade on watch delete, one channel per kind) | t-5 |
| R6 | `PRODUCT_RACE` regex still matches `watch.user_id, …` → concurrent duplicate add returns 500 instead of the existing watch | t-6 |
| R7 | Channel AAD still binds a user id → channels saved in one run can't be decrypted after restart (c-5) or crash on legacy rows | t-7 |
| R8 | `price_drop_delivery` re-keyed without user → repeat alerts or missed re-arm after target change | t-9 |
| R9 | Route loads still `error(401, 'Sign in first')` when `locals.user` is absent → fresh DB shows 401, not the watchlist (c-1) | t-10 |
| R10 | Guard reads `event.url.host` (which adapter-node derives from `ORIGIN`) instead of the raw `Host` header; lax parsing (`localhost.evil.com`, case, ports, missing Host) | t-3 |
| R11 | Guard wired after a `/health` short-circuit or after another handle → some path skips the loopback check | t-13 |
| R12 | Kit CSRF check is compiled out in dev (`!__SVELTEKIT_DEV__`) and only covers form content-types → a test against dev/unit is vacuous; a new action escapes the test list | t-17 |
| R13 | DNS-rebinding shape (Host=evil, Origin=http://evil) passes Kit's CSRF because self-origin is derived from Host → only the Host guard stops it | t-17 |
| R14 | Header keeps a link to a deleted route (`Account` → /account/password) or footer missing | t-4 |
| R15 | A deleted route is still answered (catch-all route, `/api/auth/*` handled in hooks, redirect instead of 404) | t-16 |
| R16 | Dangling import of a deleted auth module / better-auth breaks build | t-14 |
| R17 | `BETTER_AUTH_SECRET` or `ORIGIN` still effectively required; Playwright webServer inherits a developer's shell env and masks it | t-18 |
| R18 | Restart persistence only proven at lib level; real `node build` restart on the same file (Windows lock, migrate re-run) untested | t-18 |
| R19 | Stale `ORIGIN` in `.env` makes CSRF reject legit POSTs on 127.0.0.1 | t-15 |
| R20 | e2e seed still creates users / cross-user watches → suite asserts against rows that can't exist | t-8 |

## Plan

```
Phase 02-single-user — 18 tasks across 7 waves

Wave 1
  t-1  Add migrated temp-DB test harness
       files:    src/lib/server/testing/db-harness.ts (new),
                 src/lib/server/testing/db-harness.spec.ts (new),
                 src/lib/server/health.spec.ts
       covers:   (enabler for c-5)
       desc:     createTestDb(): temp dir + createDb + migrateDb on the real drizzle/
                 folder, dispose() closes the client then removeTempDir (best-effort on
                 win32). Exports MIGRATIONS_FOLDER. health.spec switches its import.
       contract: two createTestDb() calls get distinct files; after dispose()
                 db.$client.execute rejects as closed and (non-win32) the dir is gone;
                 a fresh harness DB has a __drizzle_migrations row count equal to
                 the journal's entry count (fails if the harness points at a stale
                 or wrong migrations folder).

  t-2  Drop user scope: schema + migration 0009
       files:    src/lib/server/db/watch.schema.ts, src/lib/server/db/channel.schema.ts,
                 src/lib/server/db/schema.ts, src/lib/server/db/auth.schema.ts (delete),
                 src/lib/server/db/alert.schema.ts (delete),
                 drizzle/0009_single_user.sql (new), drizzle/meta/0009_snapshot.json (new),
                 drizzle/meta/_journal.json, src/lib/server/db/migrate.spec.ts
       covers:   c-5
       desc:     Remove user_id from watch / notify_channel / price_drop_delivery
                 (rebuild via drizzle-kit generate), unique (shop, product_id),
                 notify_channel PK (kind), delivery FK (kind); drop user, session,
                 account, verification, alert_channel. Hand-append: delete
                 notify_channel rows with config_enc IS NULL and their deliveries.
                 migrate.spec uses migrationsFolder(), seeds the 0008 shape by raw SQL.
       contract: (R1) 'upgrade 0008→0009': one user's 3 watches, 5 price_points,
                 2 check_failures, 1 encrypted notify_channel, 1 delivery → identical
                 row counts and ids after migrateDb; fails if the rebuild cascades.
                 (R2) 'multi-user collision': alice and bob both watch B0X → migrateDb
                 rejects AND the DB is untouched (last __drizzle_migrations row is
                 still 0008, watch still has user_id).
                 (R3) the upgrade test asserts PRAGMA table_info(watch) has no user_id,
                 so a skipped 0009 fails it.
                 (R4) a 0008 notify_channel row with config_enc NULL plus its
                 delivery are both gone after 0009 (no orphan delivery).
                 sqlite_master lists none of user/session/account/verification/
                 alert_channel; `pnpm db:generate` emits no new migration.

  t-3  Add loopback Host guard module
       files:    src/lib/server/local-request.ts (new),
                 src/lib/server/local-request.spec.ts (new)
       covers:   c-7
       desc:     Pure isLoopbackHost(hostHeader) + createLocalRequestHandle() that
                 reads event.request.headers.get('host') only and answers 403 text
                 without calling resolve. No $app imports.
       contract: (R10) accepts 'localhost', 'localhost:4173', '127.0.0.1',
                 '127.0.0.1:65535', 'LocalHost:80'; rejects null, '', 'evil.com',
                 'localhost.evil.com', 'evil.com:localhost', '127.0.0.1.nip.io',
                 'localhost.', '[::1]', '[::1]:4173', '0.0.0.0', '127.0.0.2',
                 'localhost:', 'localhost:abc', 'localhost:123456',
                 'user@localhost', 'localhost, evil.com'.
                 Handle: event.url = http://localhost/ but Host 'evil.com' → 403 and
                 resolve never called (fails if the guard reads event.url);
                 X-Forwarded-Host: localhost with Host evil.com → 403.

  t-4  Strip auth from header; add Source footer
       files:    src/routes/+layout.svelte, src/routes/+layout.server.ts (delete),
                 src/routes/layout.server.spec.ts (delete), src/lib/nav.ts,
                 src/lib/nav.spec.ts, src/routes/layout.ssr.spec.ts (new)
       covers:   c-4
       desc:     Header always rendered, links Watchlist + Alerts only, no Sign out
                 form; <footer> with 'Source' → https://github.com/Rivil/price-check.
                 navItems loses isAdmin; NavHref narrows to '/' | '/account/alerts'.
       contract: (R14) nav.spec: every navItems() href has a matching
                 src/routes/<href>/+page.svelte on disk — fails while 'Account' →
                 /account/password remains; labels exactly ['Watchlist', 'Alerts'].
                 layout.ssr.spec (svelte/server render, $app/state + $app/paths
                 mocked): html contains a <footer> anchor 'Source' with href exactly
                 https://github.com/Rivil/price-check, and no 'Sign out', '/logout'
                 or 'Admin'.

Wave 2 (depends t-1, t-2)
  t-5  Port schema specs to the db harness
       files:    src/lib/server/db/watch.schema.spec.ts,
                 src/lib/server/db/channel.schema.spec.ts,
                 src/lib/server/db/price-point.schema.spec.ts,
                 src/lib/server/db/check-failure.schema.spec.ts,
                 src/lib/server/db/alert.schema.spec.ts (delete)
       covers:   c-5
       depends:  t-1, t-2
       contract: (R5) on a fresh harness DB: second watch with same (shop,
                 product_id) rejects, same product_id on another shop inserts;
                 deleting a watch removes its price_point, check_failure and
                 price_drop_delivery rows; second notify_channel with kind 'ntfy'
                 rejects; deleting the ntfy channel removes its deliveries; a
                 delivery whose kind has no channel rejects (FK).

  t-6  Unscope watch, check and sparkline libs
       files:    src/lib/server/watches.ts, src/lib/server/watches.spec.ts,
                 src/lib/server/checks.ts, src/lib/server/checks.spec.ts,
                 src/lib/server/sparklines.ts, src/lib/server/sparklines.spec.ts
       covers:   c-1, c-5
       depends:  t-1, t-2
       desc:     Drop the userId parameter from every function; update PRODUCT_RACE
                 to the new constraint message.
       contract: (R6) Promise.all of two addWatch() for the same URL (stubbed
                 check) → both resolve to the same id and exactly one watch row;
                 fails if PRODUCT_RACE still expects watch.user_id.
                 listWatches on a fresh DB → []; getWatch/deleteWatch of an unknown
                 id → null/false; checkNow of an unknown id → not-found result, no
                 throw; sparklines returns a series for every watch.

  t-7  Bind channel encryption to install, not user
       files:    src/lib/server/alerts/crypto.ts, src/lib/server/alerts/crypto.spec.ts,
                 src/lib/server/alerts/channels.ts, src/lib/server/alerts/channels.spec.ts
       covers:   c-5
       depends:  t-1, t-2
       desc:     channelAad(kind) = ['alert-channel', kind]; channels API loses userId;
                 log lines name the kind only.
       contract: (R7) saveChannel via client A, close A, open client B on the same
                 file with the same key → listChannels decrypts the identical config
                 (restart at lib level). A row sealed with the legacy AAD
                 ['alert-channel','alice','ntfy'] → listChannels returns it flagged
                 undecryptable without throwing and channelsFor skips it; config_enc
                 copied from 'ntfy' onto the 'smtp' row fails to decrypt (kind still
                 bound); wrong key → undecryptable, no throw, log has no topic/token.

  t-8  Rebuild e2e seed for a userless DB
       files:    e2e/seed.ts, e2e/accounts.ts, e2e/harness.e2e.ts, playwright.config.ts
       covers:   c-2
       depends:  t-2
       desc:     Seed inserts watches/points/failures/channels directly (no
                 auth-factory); drop SEEDED_* users, signIn/submitLogin, owner, the
                 cross-user otherPriced watch and E2E_SECRET; webServer env drops
                 BETTER_AUTH_SECRET and ORIGIN.
       contract: (R20) harness.e2e 'fresh seed': sqlite_master has no user/session
                 table and the watch ids equal exactly Object.values(SEEDED_WATCHES)
                 ids; seed.ts still throws for a non-file: DATABASE_URL.

Wave 3
  t-9  Unscope alert dispatch and scheduler
       files:    src/lib/server/alerts/alerts.ts, src/lib/server/alerts/alerts.spec.ts,
                 src/lib/server/alerts/live.spec.ts, src/lib/server/scheduler.spec.ts
       covers:   c-5
       depends:  t-6, t-7
       contract: (R8) below-target check with an enabled ntfy channel delivers once;
                 a second evaluation at the same target sends nothing; changing the
                 target re-arms and sends again; removing then re-adding the channel
                 re-alerts (delivery cascaded). scheduler.spec: one scheduled check of
                 a below-target watch → exactly one send through a channel saved
                 without any user.

  t-10 Unscope route loads and actions
       files:    src/routes/+page.server.ts, src/routes/page.server.spec.ts,
                 src/routes/watches/[id]/+page.server.ts,
                 src/routes/watches/[id]/page.server.spec.ts,
                 src/routes/account/alerts/+page.server.ts,
                 src/routes/account/alerts/page.server.spec.ts
       covers:   c-1, c-5
       depends:  t-6, t-7
       desc:     Remove every locals.user read and error(401, 'Sign in first').
       contract: (R9) / load with locals = {} on a fresh harness DB returns
                 watches: [] and throws neither a 401 HttpError nor a Redirect;
                 watches/[id] load for an unknown id → 404, target/delete actions
                 succeed with locals = {}; account/alerts save then load with
                 locals = {} returns the channel, invalid form → fail(400) and no row.

  t-11 Port watch-flow e2e specs off sign-in
       files:    src/routes/watchlist.e2e.ts, src/routes/page.svelte.e2e.ts,
                 src/routes/at-target.e2e.ts, src/routes/watches/[id]/watch-page.e2e.ts,
                 src/routes/account/alerts/alerts.e2e.ts
       covers:   c-1
       depends:  t-8
       contract: watchlist.e2e lists exactly the seeded watch titles (former
                 member + design rows merged) — fails if any spec still depends on a
                 per-user subset; no spec imports signIn (removed export → tsc error).

  t-12 Port layout e2e specs; footer on every page
       files:    src/routes/header.e2e.ts, src/routes/layout.e2e.ts,
                 src/routes/focus.e2e.ts, src/routes/contrast.e2e.ts,
                 src/routes/chart-a11y.e2e.ts
       covers:   c-4
       depends:  t-4, t-8
       contract: header.e2e for '/', '/watches/<seeded>', '/account/alerts' and an
                 unknown path (404 page): exactly one footer link named 'Source' with
                 href https://github.com/Rivil/price-check; header has no 'Sign out'
                 button and no 'Admin' or 'Account' link.

Wave 4 (depends t-3, t-4, t-10)
  t-13 Rewire hooks: Host guard first, auth out
       files:    src/hooks.server.ts, src/hooks.server.spec.ts, src/app.d.ts,
                 src/lib/server/alerts/backfill.ts (delete),
                 src/lib/server/alerts/backfill.spec.ts (delete)
       covers:   c-1, c-7
       depends:  t-3, t-4, t-10
       desc:     handle = createLocalRequestHandle() alone (no access/better-auth
                 handles); init drops backfill; Locals empty.
       contract: (R11) hooks.handle with Host 'evil.example' on '/health' → 403 and
                 resolve not called (fails if a /health bypass precedes the guard);
                 Host 'localhost:5173' on '/' → resolve called once, no redirect to
                 /login; init order is exactly ['key', 'migrated', 'scheduler'].

Wave 5
  t-14 Delete auth routes and server libs
       files:    src/routes/login/ (delete dir), src/routes/logout/ (delete dir),
                 src/routes/account/password/ (delete dir), src/routes/admin/ (delete dir),
                 src/routes/no-public-signup.spec.ts (delete),
                 src/lib/server/{access,auth,auth-factory,accounts,admin-bootstrap,
                 login-limiter,own-password}.ts + their .spec.ts (delete),
                 src/lib/server/cli/admin-create.ts (delete),
                 src/lib/server/testing/auth-harness.ts (delete),
                 src/routes/removed-routes.spec.ts (new)
       covers:   c-3
       depends:  t-5, t-6, t-7, t-9, t-11, t-12, t-13
       contract: (R16) removed-routes.spec fails if any +page*/+server* file exists
                 under login, logout, account/password, admin or api/auth, if a
                 root-level rest route ([...x]) exists that would answer those paths,
                 or if any file in src/ or e2e/ imports 'better-auth' or a deleted
                 module path; `pnpm check` passes.

  t-17 Prove CSRF + Host guard on the built server
       files:    e2e/local-guard.e2e.ts (new), e2e/action-endpoints.ts (new),
                 src/routes/action-endpoints.spec.ts (new)
       covers:   c-6, c-7
       depends:  t-8, t-10, t-13
       desc:     ACTION_ENDPOINTS lists every named action URL; Host tests use
                 node:http.request (fetch can't set Host) against the preview server.
       contract: (R12) for every ACTION_ENDPOINTS entry, POST with Origin
                 https://evil.example as urlencoded, multipart and text/plain → 403,
                 plus Origin 'null' and no Origin → 403; a follow-up GET shows the
                 seeded watch/channel unchanged; a same-origin control POST is not 403
                 (so the test isn't vacuous). action-endpoints.spec fails when a
                 +page.server.ts declares an action not in ACTION_ENDPOINTS, or when
                 vite.config.ts sets csrf.trustedOrigins.
                 (R13) POST with Host evil.example AND Origin http://evil.example → 403;
                 GET '/', '/health', '/watches/<id>/__data.json' with Host
                 evil.example → 403; Host '127.0.0.1:4173' and 'localhost:9' → not 403;
                 request with no Host header (setHost: false) → 403.

Wave 6 (depends t-14)
  t-15 Remove better-auth dependency and secret env
       files:    package.json, pnpm-lock.yaml, src/env.ts, src/env.spec.ts,
                 .env.example, README.md, scripts/repo-hygiene.spec.ts
       covers:   c-2
       depends:  t-14
       desc:     Drop better-auth + auth deps and admin:create / auth:schema scripts;
                 drop BETTER_AUTH_SECRET; ORIGIN optional pass-through; .env.example
                 lists only DATABASE_URL and ALERTS_ENCRYPTION_KEY.
       contract: env.spec: keys are exactly ALERTS_ENCRYPTION_KEY,
                 CHECK_INTERVAL_HOURS, DATABASE_URL, ORIGIN, SCHEDULER_DISABLED and
                 validate('ORIGIN', undefined) → { value: undefined }.
                 (R19) repo-hygiene.spec fails if package.json deps include
                 better-auth/auth, scripts include admin:create/auth:schema,
                 .env.example contains BETTER_AUTH_SECRET or an ORIGIN line, or
                 README mentions admin:create / BETTER_AUTH_SECRET.

  t-16 Prove removed routes 404 over HTTP
       files:    e2e/removed-routes.e2e.ts (new)
       covers:   c-3
       depends:  t-8, t-14
       contract: (R15) GET and same-origin POST (urlencoded and JSON) to /login,
                 /logout, /account/password, /admin/users, /admin/users/x/password,
                 /api/auth, /api/auth/get-session, /api/auth/sign-in/email and
                 /login/__data.json → status exactly 404 with no Location and no
                 Set-Cookie header (fails on any redirect to / or a lingering
                 better-auth handler).

Wave 7 (depends t-15)
  t-18 Prove fresh start, minimal env, restart persistence
       files:    e2e/spawn-server.ts (new), e2e/server-lifecycle.e2e.ts (new)
       covers:   c-1, c-2, c-5
       depends:  t-8, t-15
       desc:     Helper spawns `node build` (cwd repo root) on a free port with an
                 env built from scratch (PATH/SYSTEMROOT + given vars, never
                 process.env), SCHEDULER_DISABLED=1, waits for /health, stop() awaits
                 'exit'; fails fast if build/index.js is missing.
       contract: (R17) with only DATABASE_URL + ALERTS_ENCRYPTION_KEY (+PORT,
                 SCHEDULER_DISABLED) set: '/', '/account/alerts', '/health' → 200
                 even when the parent has BETTER_AUTH_SECRET/ORIGIN exported;
                 negative controls: dropping ALERTS_ENCRYPTION_KEY or DATABASE_URL
                 → process exits non-zero before ready.
                 c-1: fresh temp DB, GET '/' with redirect 'manual' → 200, empty
                 watchlist text, no Set-Cookie.
                 (R18) run 1: save an ntfy channel through the alerts form (.invalid
                 host, r-01), insert a watch + 2 price_points via createDb (no live
                 check, r-01); stop and await exit; run 2 on the same file: '/' lists
                 the watch, its page shows both points, /account/alerts shows the
                 channel configured (decrypted, not 'needs re-entry').
```

## Coverage

| Criterion | Tasks |
|---|---|
| c-1 fresh DB → empty watchlist, no login | t-6, t-10, t-11, t-13, t-18 |
| c-2 starts without BETTER_AUTH_SECRET | t-8, t-15, t-18 |
| c-3 removed routes 404 | t-14, t-16 |
| c-4 no Sign out/Admin; Source footer | t-4, t-12 |
| c-5 data survives restart | t-2, t-5, t-6, t-7, t-9, t-10, t-18 |
| c-6 foreign Origin POST → 403 | t-17 |
| c-7 non-loopback Host → 403 | t-3, t-13, t-17 |

7/7 criteria covered.

## Judgment calls

- Incremental 0009 rebuild migration, not a squashed fresh baseline — a new 0000 would crash with "table already exists" on any DB already at 0008 (dev local.db, e2e caches); rebuild is safe because libsql's `migrate()` runs `PRAGMA foreign_keys=off` around one transaction (verified in node_modules), which t-2's upgrade test pins.
- Two-user collision fails the migration and rolls back, rather than deduping rows — spec says multi-user DBs are unsupported; silently picking a survivor loses data, a rolled-back refusal is honest and testable.
- 0009 drops `alert_channel` and deletes `config_enc IS NULL` channels + their deliveries; backfill.ts is deleted — the backfill's source table is user-keyed and gone, so those rows could never be completed; leaving them yields permanently "no settings" ghosts.
- Channel AAD becomes `['alert-channel', kind]`; server-era rows sealed with a user id become undecryptable and must degrade gracefully — no installs exist and old-data import is a non-goal; a legacy-AAD fallback is impossible once user_id is dropped.
- Host guard is strict to the spec literal: `[::1]`, `0.0.0.0`, `127.0.0.2` and trailing-dot `localhost.` are rejected — the criterion names exactly localhost/127.0.0.1, and the Electron server binds 127.0.0.1; widening is easy later, narrowing after release is not.
- Guard reads the raw `Host` header, not `event.url` — adapter-node builds `event.url` from `ORIGIN` when set, which would make the guard check a constant.
- `ORIGIN` stays declared but optional, and is removed from `.env.example` and the e2e env — leaving `ORIGIN=localhost` makes Kit's CSRF reject legit POSTs from 127.0.0.1; unset, self-origin follows Host, and the Host guard makes that safe (the R13 test proves the pair).
- c-6/c-7 are proven only against built servers (preview / `node build`), never vitest or `pnpm dev` — Kit compiles the CSRF check out under `__SVELTEKIT_DEV__`, so a dev-mode test would pass vacuously.
- Accepted gap: adapter-node serves static assets (sirv) before hooks, so `/_app/immutable/*` bypasses the Host guard — they hold no user data; t-17 asserts every data-bearing path (pages, `__data.json`, `/health`, actions) instead of claiming "every request" literally.
- c-5 restart proven by spawning `node build` twice with a scrubbed env, rather than only a lib-level reopen — Playwright's webServer inherits `process.env`, so a developer's exported `BETTER_AUTH_SECRET` would mask c-2; the scrubbed spawn also exercises migrate-on-already-migrated and the Windows file lock (stop awaits `exit`).
- Watches in the restart test are inserted via `createDb`, not the add form — adding through the UI performs a live Amazon fetch (r-01).
- `ACTION_ENDPOINTS` + a sync spec, rather than a hand-picked couple of actions — "any action" must not silently exclude a future action; the spec fails on drift.
- Accepted red window between t-2 and t-13/t-14: schema changes break consumer specs and backfill.ts until their owning tasks land — bundling all consumers into t-2 would make a 25-file task with no single risk owner; each wave-2/3 task's scoped tests go green as it lands.
- t-14 is a large pure-deletion task kept whole — splitting deletions across tasks multiplies dangling-import windows; its one risk (R16) is caught by one spec + `pnpm check`.
- Footer checked by an SSR render spec (t-4) plus e2e incl. a 404 page (t-12), not a vitest-browser component test — `+layout.svelte` imports `$app/state`/`$app/paths`, which the browser project can't resolve without mocks; SSR with mocks is deterministic.
