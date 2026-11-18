# 02-single-user: panel synthesis

Inputs: risk.md, mvp.md, verification.md, read against spec.toml, project.toml, rules.toml and the code on `phase/02-single-user`.

The binding constraint for scoring is commit gating. `/dross-execute` commits each task on its own, and a commit only goes through if `pnpm test:unit --run` and `pnpm lint` are observed green. Facts that decide what "green" means here, checked in the repo:

- `vitest` runs two projects: `server` (`src/**/*.spec.ts`, `scripts/**/*.spec.ts`) and `client` (browser, `src/**/*.svelte.spec.ts`). It does not run `*.e2e.ts`. vitest does not type-check, so only runtime breakage turns it red: imports of deleted modules, positional-argument shifts, and missing tables or columns.
- `pnpm lint` is `prettier --check . && eslint .`. eslint is type-aware only for `.svelte` files, so a dangling import in `e2e/` does not fail lint. Playwright e2e is outside the commit gate.
- `src/lib/server/testing/auth-harness.ts` builds a real better-auth instance and creates users. 22 specs depend on it, including every data and route spec. Dropping the `user` table or `auth.schema.ts` while those specs exist turns all of them red.
- `src/routes/no-public-signup.spec.ts` asserts `keys` contains `/src/lib/server/auth-factory.ts`, so deleting auth-factory makes it fail.
- `scripts/readme.spec.ts:51-53` asserts that README contains `pnpm admin:create` and that the script exists.
- `src/routes/+layout.server.ts` imports `isAdminRole` from `access.ts`.
- `loginEmail` is also consumed by `src/routes/account/alerts/+page.svelte` and `page.svelte.spec.ts` (browser project).
- adapter-node 6.0.0 (`src/handler.js:46-55, 151-153`): with `ORIGIN` unset, the origin is `https://<Host>` because the protocol defaults to `https`. A request with no Host is answered 400 before hooks run.
- `env.ts` declares `ORIGIN` with no schema, which makes it required today.

## Scores

Scale 1–5.

| Dimension | risk | mvp | verification |
|---|---|---|---|
| Criteria coverage | **5**: every criterion has a unit-level and a black-box proof. It adds the upgrade path (R1–R4) and names the static-asset gap in c-7. | **3**: covers 7/7, but thinly. c-5 is lib-only. c-2 is proven through a preview webServer that inherits `process.env`, so the test can't show the server starts with two vars. c-7 is unit-only. c-6 tests 3 actions. | **5**: every criterion has a black-box contract on `node build` plus unit backstops. It drops the upgrade path by design (squash). |
| Test-contract specificity | **4**: the sharpest tables (Host accept/reject, cascade row counts, R-tags). Two contracts are wrong against adapter-node 6: no-Host → 403 actually gives 400 when ORIGIN is unset, and the t-18 restart form POST with ORIGIN unset is rejected by CSRF because of the https default. Its Host e2e runs on preview, where `preview.allowedHosts` masks a missing hook. | **3**: concrete, but there's no cascade or upgrade test, the Host table is short and CSRF covers only 3 actions. It has the best same-origin control (`/?/add` with an unsupported URL → 400, not 403, with no live fetch). | **5**: precise and pinned (AAD literal, exact table list, snapshot/schema drift). It is the only draft that gets the preview `allowedHosts` masking and the https default right. |
| Granularity | **4**: 18 right-sized tasks. t-14 is a large pure deletion and t-1 is small. | **2**: t-1 is about 40 files across db, lib and routes. t-3 is about 30 files plus a migration. Both break the 5-file / 2-layer rule. | **4**: 17 tasks of reasonable size. t-11 is a large pure deletion. |
| Wave correctness (green per commit) | **1**: t-2 deletes `auth.schema.ts` and drops the user tables in wave 1, while the auth libs, their specs and auth-harness stay until t-14. vitest is red from t-2 through t-13, and the draft accepts this in its judgment calls. t-15 leaves `scripts/readme.spec.ts` red. t-8 drops `BETTER_AUTH_SECRET` from the webServer env while `env.ts` still requires it, so the e2e server can't boot. | **4**: the only draft sequenced for green commits. User scope goes before the auth-table drop, with two migrations. One hole: t-3 keeps `no-public-signup.spec.ts`, claiming it "still passes", but it asserts auth-factory.ts exists, so it goes red. | **1**: t-1 rebaselines migrations, dropping the auth tables and `auth.schema.ts`, in wave 1. That leaves vitest red until t-11, which the draft accepts. t-7 deletes `access.ts` while `+layout.server.ts` (which imports `isAdminRole`) lives until t-11. |

**Skeleton: mvp.** It is the only draft whose commit sequence can stay green: user_id comes out of the data tables first, the auth tables are dropped in a later migration after auth code is gone, then env and deps, then e2e. That spine survives here. MVP's oversized t-1 is re-sliced along the watch/channel seam that risk (t-6/t-7) and verification (t-4/t-6) both drew. Most contracts, and all the black-box proof tasks, are grafted from risk and verification.

**Playwright e2e cannot stay green mid-phase.** e2e goes red at t-3 (header markup) and certainly at t-4 (the seed writes `alert_channel` and users). It stays red until t-9 through t-13 land. No draft offers a way around this: MVP argues it's fine because e2e is outside the commit gate, and risk and verification accept red suites outright. The PR's required Playwright check is only evaluated at ship time.

## Merged plan

```
Phase 02-single-user — 13 tasks across 7 waves

Wave 1
  t-1  Add migrated temp-DB test harness                              [risk]
       files:    src/lib/server/testing/test-db.ts (new),
                 src/lib/server/testing/test-db.spec.ts (new),
                 src/lib/server/health.spec.ts
       desc:     createTestDb(): temp dir + createDb + migrateDb on the real drizzle/ folder;
                 dispose() closes the client then removeTempDir (best-effort on win32).
                 Exports MIGRATIONS_FOLDER; health.spec switches its import off auth-harness.
                 (File name test-db.ts per mvp+verification; risk called it db-harness.ts.)
       covers:   c-5 (enabler)
       depends:  —
       contract: two createTestDb() calls get distinct files; after dispose()
                 db.$client.execute rejects as closed and (non-win32) the dir is gone;
                 a fresh harness DB has __drizzle_migrations row count === the journal's entry
                 count — fails if the harness points at a stale or wrong migrations folder.
                 health.spec still 503s on a closed client.

  t-2  Add loopback Host guard module                                 [risk+verification]
       files:    src/lib/server/local-request.ts (new),
                 src/lib/server/local-request.spec.ts (new)
       desc:     Pure isLoopbackHost(host: string | null) + createLocalRequestHandle(): reads
                 event.request.headers.get('host') only, answers 403 text without calling
                 resolve. Hostname case-insensitive. No $app imports.
       covers:   c-7
       depends:  —
       contract: accepts 'localhost', 'localhost:4173', '127.0.0.1', '127.0.0.1:65535',
                 'LocalHost:80'; rejects null, '', 'evil.example', 'evil.example:4173',
                 'localhost.evil.example', 'evil.com:localhost', '127.0.0.1.nip.io',
                 'localhost.', '[::1]', '[::1]:4173', '0.0.0.0', '127.0.0.2', 'localhost:',
                 'localhost:abc', 'localhost:123456', 'user@localhost', 'localhost, evil.com'
                 — a startsWith/includes implementation fails the look-alike rows.
                 Handle: event.url = http://localhost/ (as ORIGIN would set it) with Host
                 'evil.example' → 403 and resolve never called (fails if the guard reads
                 event.url); X-Forwarded-Host: localhost with Host evil.example → 403;
                 '/health' with a foreign Host → 403 (no exemption).

  t-3  Strip auth from header; add Source footer                      [verification+risk+mvp]
       files:    src/routes/+layout.svelte, src/routes/+layout.server.ts (delete),
                 src/routes/layout.server.spec.ts (delete), src/lib/nav.ts, src/lib/nav.spec.ts,
                 src/lib/components/SiteFooter.svelte (new),
                 src/lib/components/SiteFooter.svelte.spec.ts (new)
       desc:     Header always rendered (no data.nav gate), Watchlist + Alerts only, no Sign out
                 form; navItems loses isAdmin and the Account item. SiteFooter with 'Source' →
                 https://github.com/Rivil/price-check rendered outside any {#if} so error pages
                 get it. Deleting +layout.server.ts also removes the only non-auth importer of
                 access.ts (unblocks t-7).
       covers:   c-4
       depends:  —
       contract: nav.spec: navItems({ pathname: '/' }).map(i => i.href) toEqual
                 ['/', '/account/alerts'] and labels exactly ['Watchlist', 'Alerts']; every
                 navItems() href has a matching src/routes/<href>/+page.svelte on disk — fails
                 while 'Account' → /account/password remains [risk].
                 SiteFooter.svelte.spec (browser): exactly one link named 'Source' with href ===
                 'https://github.com/Rivil/price-check' (trailing slash, .git or http:// fails)
                 inside a contentinfo landmark [verification]. Footer-on-every-page is proven in
                 t-11.

Wave 2 (depends t-1)
  t-4  Unscope alert channels: schema 0009, AAD, dispatch, alerts page
                                       [mvp t-1 re-sliced; contracts risk t-2/t-5/t-7/t-9/t-10,
                                        verification t-6/t-8/t-10]
       files:    src/lib/server/db/channel.schema.ts, src/lib/server/db/schema.ts,
                 src/lib/server/db/alert.schema.ts (delete),
                 src/lib/server/db/alert.schema.spec.ts (delete),
                 src/lib/server/db/channel.schema.spec.ts,
                 drizzle/0009_single_user_channels.sql (new), drizzle/meta/0009_snapshot.json (new),
                 drizzle/meta/_journal.json, src/lib/server/db/migrate.spec.ts,
                 src/lib/server/alerts/crypto.ts, src/lib/server/alerts/crypto.spec.ts,
                 src/lib/server/alerts/channels.ts, src/lib/server/alerts/channels.spec.ts,
                 src/lib/server/alerts/alerts.ts, src/lib/server/alerts/alerts.spec.ts,
                 src/lib/server/alerts/live.spec.ts,
                 src/lib/server/alerts/backfill.ts (delete),
                 src/lib/server/alerts/backfill.spec.ts (delete),
                 src/lib/server/scheduler.spec.ts,
                 src/hooks.server.ts, src/hooks.server.spec.ts,
                 src/routes/account/alerts/+page.server.ts,
                 src/routes/account/alerts/page.server.spec.ts,
                 src/routes/account/alerts/+page.svelte,
                 src/routes/account/alerts/page.svelte.spec.ts
       desc:     notify_channel loses user_id (PK = kind, no user FK); price_drop_delivery loses
                 user_id (FK (kind) → notify_channel). drizzle-kit-generated rebuild; drop
                 alert_channel; hand-append delete of config_enc IS NULL channels + their
                 deliveries. channelAad(kind) = ['alert-channel', kind]; channels API and
                 alertAfter* lose the user; logs name the kind only. backfill.ts deleted, so
                 hooks init drops the backfill step (auth handles stay until t-6). Alerts page:
                 no signedIn/401, loginEmail removed (email cards start with an empty
                 recipient; +page.svelte and its browser spec updated — a file all three drafts
                 missed). watch keeps user_id here, so specs that insert watches still create a
                 user row.
       covers:   c-1, c-5
       depends:  t-1
       contract: migrate.spec 'upgrade 0008→0009' (R1): one user's 2 watches, 5 price_points,
                 1 encrypted notify_channel and 1 delivery → identical row counts and ids after
                 migrateDb; fails if the notify_channel rebuild cascades deliveries.
                 PRAGMA table_info(notify_channel) and (price_drop_delivery) have no user_id —
                 a 0009 silently skipped by a bad journal `when` fails it (R3).
                 (R2) alice and bob both have an 'ntfy' channel → migrateDb rejects AND the DB
                 is untouched (last __drizzle_migrations row still 0008).
                 (R4) a 0008 notify_channel with config_enc NULL plus its delivery are both gone
                 after 0009; sqlite_master has no alert_channel.
                 channel.schema.spec (R5, channel half): second notify_channel kind 'ntfy'
                 rejects; deleting the ntfy channel removes its deliveries; a delivery whose kind
                 has no channel rejects (FK).
                 crypto.spec: channelAad('ntfy') === '["alert-channel","ntfy"]' (pinned
                 literal); a blob sealed for 'ntfy' fails to open as 'smtp'.
                 channels.spec (R7): saveChannel on client A, close A, listChannels on client B
                 over the same file + key returns the identical config; a row sealed with legacy
                 AAD ['alert-channel','alice','ntfy'] → flagged undecryptable, no throw, and
                 channelsFor skips it; wrong key → undecryptable, no throw, log contains no
                 topic/token; two saves of 'ntfy' leave one row.
                 alerts.spec (R8): enabled ntfy channel + watch at target → exactly one send and
                 a delivery row (watch, 'ntfy', target); a second evaluation at the same target
                 sends nothing; changing the target re-arms and sends again; removing then
                 re-adding the channel re-alerts; disabled channel → zero sends.
                 scheduler.spec: one scheduled check of a below-target watch → exactly one send
                 through a channel saved with no user argument.
                 account/alerts page.server.spec: load({ locals: {} }) → three null cards, no
                 401, returned data has no loginEmail key; ?/save ntfy then load returns the
                 topic; invalid form → fail(400) and no row.
                 hooks.server.spec: init order toEqual ['key', 'migrated', 'scheduler'].

Wave 3
  t-5  Unscope watches: schema 0010, domain libs, watch routes
                                       [mvp t-1 re-sliced; contracts risk t-2/t-5/t-6/t-10,
                                        verification t-1/t-4/t-5/t-9, mvp t-1]
       files:    src/lib/server/db/watch.schema.ts,
                 drizzle/0010_single_user_watches.sql (new), drizzle/meta/0010_snapshot.json (new),
                 drizzle/meta/_journal.json, src/lib/server/db/migrate.spec.ts,
                 src/lib/server/db/watch.schema.spec.ts,
                 src/lib/server/db/price-point.schema.spec.ts,
                 src/lib/server/db/check-failure.schema.spec.ts,
                 src/lib/server/watches.ts, src/lib/server/watches.spec.ts,
                 src/lib/server/checks.ts, src/lib/server/checks.spec.ts,
                 src/lib/server/sparklines.ts, src/lib/server/sparklines.spec.ts,
                 src/lib/server/scheduler.spec.ts,
                 src/lib/server/alerts/alerts.spec.ts, src/lib/server/alerts/live.spec.ts,
                 src/routes/+page.server.ts, src/routes/page.server.spec.ts,
                 src/routes/watches/[id]/+page.server.ts,
                 src/routes/watches/[id]/page.server.spec.ts
       desc:     watch loses user_id and its user FK/index; unique (shop, product_id).
                 drizzle-kit-generated rebuild. Every watch/check/sparkline function drops its
                 userId parameter; PRODUCT_RACE matches the new constraint message. / and
                 watches/[id] drop every locals.user read and error(401). All specs move from
                 auth-harness to test-db.ts (no user rows needed any more).
       covers:   c-1, c-5
       depends:  t-4
       contract: migrate.spec 'upgrade 0009→0010' (R1): one user's 3 watches, 5 price_points,
                 2 check_failures and 1 delivery → identical row counts and ids after migrateDb;
                 fails if the watch rebuild cascades. PRAGMA table_info(watch) has no user_id (R3).
                 (R2) alice and bob both watch B0X → migrateDb rejects AND the DB is untouched
                 (last migration still 0009, watch still has user_id).
                 migrate.spec 'restart keeps data' [mvp]: addWatch (stub shop) + recorded price
                 point + saveChannel, close the client, createDb + migrateDb on the same file →
                 listWatches, priceHistory and listChannels return all three.
                 migrate.spec 'idempotent restart' [verification]: rows inserted after the first
                 migrateDb survive a second migrateDb on a NEW client, __drizzle_migrations count
                 unchanged.
                 schema specs (R5, watch half): second watch with the same (shop, product_id)
                 rejects, the same product_id on another shop inserts; deleting a watch removes its
                 price_point, check_failure and price_drop_delivery rows.
                 watches.spec (R6): Promise.all of two addWatch() for the same URL (stubbed
                 check) → both resolve to the same id and exactly one watch row — fails if
                 PRODUCT_RACE still expects watch.user_id. listWatches on a fresh DB → [];
                 getWatch / priceHistory / failureHistory / deleteWatch of an unknown id →
                 null / [] / [] / false; checkNow of an unknown id → not-found, no throw; checkNow
                 cooldown refusal unchanged.
                 sparklines.spec: points from two different watches both appear; points older
                 than 30 days are excluded — a leftover user join fails it.
                 page.server.spec (c-1): load({ locals: {} }) on a fresh test DB resolves
                 { watches: [] } and throws neither a 401 HttpError nor a Redirect; ?/add with a
                 fake shop then load lists it (no live fetch, r-01).
                 watches/[id] spec: load with locals {} on a seeded id → watch view; unknown id →
                 404; target action succeeds; ?/delete then load → 404.

  t-6  Rewire hooks: Host guard first, auth handles out               [risk+verification]
       files:    src/hooks.server.ts, src/hooks.server.spec.ts
       desc:     handle = createLocalRequestHandle() alone: no access handle, no
                 svelteKitHandler, no #lib/server/auth.ts import. access.ts itself is deleted in
                 t-7 (admin routes still import it until then).
       covers:   c-1, c-7
       depends:  t-2, t-4
       contract: (R11) exported handle on '/health' with Host 'evil.example' → 403 and resolve
                 never called — fails if a /health bypass precedes the guard; on '/' with Host
                 'localhost:5173' and no cookie → resolve called once, no redirect thrown
                 (a surviving /login redirect fails it). The spec has no better-auth mock, so a
                 remaining auth import fails module load [verification]. init order still
                 ['key', 'migrated', 'scheduler'].

Wave 4 (depends t-3, t-5, t-6)
  t-7  Delete auth routes, libs and tables                            [risk+verification+mvp]
       files:    src/routes/login/ (delete dir), src/routes/logout/ (delete dir),
                 src/routes/account/password/ (delete dir), src/routes/admin/ (delete dir),
                 src/routes/no-public-signup.spec.ts (delete),
                 src/lib/server/{access,auth,auth-factory,accounts,admin-bootstrap,
                 login-limiter,own-password}.ts + their .spec.ts (delete),
                 src/lib/server/cli/admin-create.ts (delete),
                 src/lib/server/testing/auth-harness.ts (delete),
                 src/lib/server/db/auth.schema.ts (delete), src/lib/server/db/schema.ts,
                 drizzle/0011_drop_auth.sql (new), drizzle/meta/0011_snapshot.json (new),
                 drizzle/meta/_journal.json, src/lib/server/db/migrate.spec.ts,
                 src/app.d.ts, src/routes/removed-routes.spec.ts (new)
       desc:     Pure deletion plus: Locals emptied, auth tables dropped by a third generated
                 migration (nothing references user any more after t-4/t-5).
                 no-public-signup.spec is deleted here because it asserts auth-factory.ts exists
                 (mvp missed this).
       covers:   c-3
       depends:  t-3, t-5, t-6
       contract: removed-routes.spec (R16): fails if any +page*/+server* file exists under
                 login, logout, account/password, admin or api/auth; if a root-level rest route
                 ([...x]) exists that would answer those paths; or if any non-test file under
                 src/ (import.meta.glob ?raw) matches /better-auth|locals\.user|\/api\/auth/ or
                 imports a deleted module path. (Scope is src/ only here; e2e/ still imports
                 auth-factory until t-9, so risk's src+e2e scope would be red now. t-9 extends it.)
                 migrate.spec 'install-owned schema' [verification]: empty DB → sqlite_master
                 tables exactly [check_failure, notify_channel, price_drop_delivery, price_point,
                 watch]; no table has a user_id column, and PRAGMA index_list/index_info shows
                 no index over user_id; schema.ts exports no `user` [mvp].
                 'schema matches snapshot': for every sqliteTable in schema.ts, getTableConfig
                 column names === PRAGMA table_info names [verification]; `pnpm db:generate`
                 emits no new migration [risk].
                 'upgrade 0010→0011': watch, price_point and notify_channel rows survive the auth
                 table drop.

Wave 5 (depends t-7)
  t-8  Remove better-auth deps and secret env                         [risk+mvp+verification]
       files:    src/env.ts, src/env.spec.ts, package.json, pnpm-lock.yaml, .env.example,
                 README.md, scripts/readme.spec.ts
       desc:     Drop BETTER_AUTH_SECRET; ORIGIN becomes optional (passthrough schema; see
                 Disagreement 4); pnpm remove better-auth and auth; drop admin:create and
                 auth:schema scripts; README/.env.example lose the secret, ORIGIN and admin
                 steps. readme.spec's 'pnpm admin:create' assertion is replaced (risk missed
                 this file; it would stay red).
       covers:   c-2
       depends:  t-7
       contract: env.spec: Object.keys(variables).sort() toEqual [ALERTS_ENCRYPTION_KEY,
                 CHECK_INTERVAL_HOURS, DATABASE_URL, ORIGIN, SCHEDULER_DISABLED] and every key
                 except DATABASE_URL validates undefined → { value: undefined } — re-adding a
                 required secret or a required ORIGIN fails it.
                 readme.spec (R19): package.json dependencies/devDependencies contain no
                 'better-auth' or 'auth'; scripts contain no admin:create / auth:schema; README
                 and .env.example never mention BETTER_AUTH_SECRET or admin:create;
                 .env.example has no ORIGIN line.

Wave 6 (depends t-8)
  t-9  Reseed e2e as one install; add node-server helper              [verification+risk+mvp]
       files:    e2e/seed.ts, e2e/accounts.ts, e2e/harness.e2e.ts, playwright.config.ts,
                 e2e/node-server.ts (new), src/routes/removed-routes.spec.ts
       desc:     Seed writes watches/points/failures with no owner (otherPriced, SEEDED_<user>
                 credentials, signIn/submitLogin and E2E_SECRET removed) and saves the design
                 ntfy channel via saveChannel with E2E_ALERTS_KEY. webServer env drops
                 BETTER_AUTH_SECRET and ORIGIN. node-server.ts: startNodeServer({ port, dbFile,
                 env }) spawns `node build` (cwd repo root) with an env built from an allowlist
                 (PATH/SystemRoot/HOME + given vars, never a process.env spread), waits for
                 /health, stop() kills and awaits 'exit' (win32 libsql lock); fails fast if
                 build/index.js is missing. removed-routes.spec's import scan extends to e2e/.
       covers:   c-2
       depends:  t-8
       contract: harness.e2e 'fresh seed': sqlite_master has no user/session table; watch ids
                 equal exactly Object.values(SEEDED_WATCHES) ids; notify_channel has exactly one
                 'ntfy' row and loadChannelConfig opens it with E2E_ALERTS_KEY; seed.ts still
                 throws for a non-file: DATABASE_URL. 'webServer env': the config's webServer env
                 has no BETTER_AUTH_SECRET or ORIGIN key. 'node-server env': a test-only probe
                 child shows no BETTER_AUTH_SECRET or ORIGIN unless passed — a process.env
                 spread fails it. removed-routes.spec (vitest) fails if any file under e2e/
                 imports better-auth or a deleted module.

Wave 7 (depends t-9)
  t-10 Strip sign-in from page-flow e2e specs                         [mvp+verification+risk]
       files:    src/routes/watchlist.e2e.ts, src/routes/watches/[id]/watch-page.e2e.ts,
                 src/routes/account/alerts/alerts.e2e.ts, src/routes/at-target.e2e.ts,
                 src/routes/chart-a11y.e2e.ts, src/routes/page.svelte.e2e.ts (delete)
       desc:     page.goto directly; cross-user ('only mine') cases deleted; counts/ordering
                 re-based on the single merged watchlist. page.svelte.e2e.ts only holds the
                 'demo sign-up page is gone' test and is deleted (see Disagreement 12).
       covers:   c-1
       depends:  t-9
       contract: watchlist.e2e 'opens without login': page.goto('/') response is 200 with no
                 redirectedFrom, h1 'Watchlist' visible, and every seeded title (formerly split
                 across member/design) listed — a redirect or a leftover owner filter fails it.
                 watch-page.e2e loads /watches/e2e-page-detail directly and shows its history;
                 alerts.e2e loads /account/alerts directly and shows the seeded design topic;
                 no spec imports signIn (removed export).

  t-11 Re-base chrome e2e; footer on every page                       [verification+risk+mvp]
       files:    src/routes/header.e2e.ts, src/routes/layout.e2e.ts, src/routes/focus.e2e.ts,
                 src/routes/contrast.e2e.ts, src/routes/health/health.e2e.ts
       desc:     Page lists become '/', a watch page, '/account/alerts' and a 404 page;
                 login/admin/password rows deleted; footer link joins focus-order and contrast
                 checks.
       covers:   c-4
       depends:  t-3, t-9
       contract: header.e2e on '/', '/watches/<seeded>', '/account/alerts' and '/no-such-page'
                 (404 error page): exactly one footer link named 'Source' with href ===
                 https://github.com/Rivil/price-check; 0 buttons named /sign out/i; no 'Admin'
                 or 'Account' link; every header nav href GETs 200.
                 health.e2e: '/healthx' → 404 (was 303 to /login) — a surviving redirect fails it.
                 contrast.e2e passes with the footer link in both colour schemes.

  t-12 Prove removed routes, CSRF and Host guard over HTTP            [risk+verification+mvp]
       files:    e2e/removed-routes.e2e.ts (new), e2e/local-guard.e2e.ts (new),
                 e2e/action-endpoints.ts (new), src/routes/action-endpoints.spec.ts (new)
       desc:     ACTION_ENDPOINTS lists every [path, action]. Removed routes and CSRF run on the
                 preview webServer (built, so Kit's CSRF check is compiled in). Host rows run on
                 `node build` via node-server.ts with raw node:http requests (fetch can't set
                 Host; preview.allowedHosts would 403 foreign Hosts with no hook).
       covers:   c-3, c-6, c-7
       depends:  t-6, t-9
       contract: c-3 (R15): GET and same-origin POST (urlencoded and JSON) with maxRedirects 0
                 to /login, /logout, /account/password, /admin/users, /admin/users/x/password,
                 /api/auth, /api/auth/get-session, /api/auth/session, /api/auth/sign-in/email and
                 /login/__data.json → status exactly 404 with no Location and no Set-Cookie.
                 c-6 (R12): for every ACTION_ENDPOINTS entry, POST with Origin
                 https://evil.example as urlencoded, multipart and text/plain → 403, plus Origin
                 'null' and no Origin → 403; a follow-up GET shows the seeded watch/channel
                 unchanged (the watch still exists after ?/delete). Control [mvp]: /?/add with
                 Origin http://localhost:4173 and an unsupported URL → 400, not 403 (no live
                 fetch, r-01). action-endpoints.spec fails when a +page.server.ts declares an
                 action missing from ACTION_ENDPOINTS, or when vite.config.ts sets
                 csrf.trustedOrigins / disables the origin check.
                 c-7 on node build spawned WITH ORIGIN=http://127.0.0.1:<port> (event.url fixed,
                 so only a raw-Host read can reject): Host evil.example on GET '/', '/health',
                 '/account/alerts', '/watches/<id>/__data.json' → 403; Host '127.0.0.1:<port>'
                 and 'localhost:9' → not 403; no Host header (setHost: false) → 403.
                 (R13) on node build spawned WITHOUT ORIGIN: POST with Host evil.example and
                 Origin https://evil.example (the self-origin adapter-node derives, given its
                 https default) → 403, which only the Host guard can produce. Without ORIGIN, a
                 missing Host gets 400 from adapter-node before hooks (handler.js:48-55), so
                 risk's no-Host → 403 row is asserted only in the ORIGIN-set spawn.

  t-13 Prove fresh start, minimal env, restart persistence            [verification+risk]
       files:    e2e/fresh-install.e2e.ts (new), e2e/restart.e2e.ts (new)
       desc:     Both spawn `node build` via node-server.ts on their own temp DB file and port.
                 Watches are inserted via createDb (adding through the UI does a live Amazon
                 fetch, r-01); restart run sets SCHEDULER_DISABLED=1.
       covers:   c-1, c-2, c-5
       depends:  t-9
       contract: c-2 (R17): env = allowlist + PORT + DATABASE_URL + ALERTS_ENCRYPTION_KEY only,
                 while the parent process exports BETTER_AUTH_SECRET and ORIGIN: '/',
                 '/account/alerts', '/health' → 200. Negative controls: dropping
                 ALERTS_ENCRYPTION_KEY or DATABASE_URL → the process exits non-zero before ready.
                 c-1: same server on a fresh temp DB: GET '/' with redirect 'manual' → 200, no
                 redirectedFrom, final pathname '/', empty-watchlist text visible, 0
                 input[type=password], no Set-Cookie.
                 c-5 (R18): server A, spawned with ORIGIN=http://127.0.0.1:<port> (adapter-node
                 defaults to https when ORIGIN is unset, which would make the same-origin POST
                 fail CSRF), saves an ntfy channel through /account/alerts?/save (.invalid host,
                 r-01); a watch + 2 price_points are inserted via createDb; stop() awaits exit.
                 Server B on the same file: '/' lists the watch, /watches/<id> shows both
                 prices, /account/alerts shows the topic decrypted (not 'needs re-entry').
```

### Coverage

| Criterion | Tasks (bold = authoritative contract) |
|---|---|
| c-1 empty watchlist directly, no login | t-4, **t-5**, t-6, t-10, **t-13** |
| c-2 starts with only DATABASE_URL + ALERTS_ENCRYPTION_KEY | **t-8**, t-9, **t-13** |
| c-3 removed routes 404 | **t-7**, **t-12** |
| c-4 no Sign out/Admin; Source footer everywhere | **t-3**, **t-11** |
| c-5 data survives restart | t-1, **t-4**, **t-5**, **t-13** |
| c-6 foreign-Origin form POST → 403 | **t-12** |
| c-7 non-loopback Host → 403 | **t-2**, t-6, **t-12** |

All 7 criteria are covered. Every task commit should leave vitest and lint green. t-4 and t-5 still break the 5-file / 2-layer rule (about 25 and 21 files). The green gate forces that: schema, libs, routes and specs on each side of the seam have to land together.

## Disagreements

**1. Migration strategy.**
- **What each draft does.**
  - risk: one incremental 0009 that drops user_id and the auth tables together.
  - mvp: 0009 for the data tables, then 0010 for the auth tables.
  - verification: squashes 0000–0008 into a regenerated baseline and drops all upgrade tests, arguing that no installs exist.
- **Default:** incremental, as three migrations: 0009 channels, 0010 watch, 0011 auth.
- **Why:** risk notes that a new 0000 crashes with "table already exists" on any DB already at 0008 (dev `local.db`, cached e2e DBs). The green gate also rules out a wave-1 squash, because the squash must drop auth tables while auth code still uses them.
- **Why it matters:** squash is less migration code and has no rebuild-cascade risk (R1). Incremental keeps existing dev DBs bootable but needs the R1/R2/R4 upgrade tests. If the human prefers squash, it can only happen at t-7, once all auth code is gone.

**2. Red windows vs green per commit, and where to cut the data work.**
- **What each draft does.**
  - risk and verification split by layer (schema task first, then consumers) and openly accept a red full suite across 5–6 waves.
  - mvp keeps all user-scope work in one ~40-file task so every commit is green. It names "channels first, then watch" as the only smaller green seam, but rejects it because six specs get edited twice and it costs an extra migration.
  - risk alone pulls the test-DB harness out as its own wave-1 task.
- **Default:** mvp's green spine, cut at mvp's own seam (t-4 channels, then t-5 watch), plus risk's separate harness (t-1).
- **Why:** risk (t-6/t-7) and verification (t-4/t-6) both separate watch work from channel work, and the coordinator's gate makes red windows non-committable.
- **Why it matters:** if t-4 turns out not to be green on its own (an undiscovered watch↔channel coupling), the fallback is mvp's monolith, which merges t-4 and t-5. The cost of the split is alerts/live/scheduler/migrate specs touched twice and one extra migration.

**3. Host guard placement, and hooks rewiring as its own task.**
- **What each draft does.**
  - mvp rewrites `access.ts` in place into the guard, and does the guard, hooks and all auth deletion in one task (t-3).
  - risk and verification add a new pure module in wave 1 and rewire hooks in a separate task.
  - verification deletes `access.ts` in that hooks task, which leaves `layout.server.spec` red.
- **Default:** new module `local-request.ts` (t-2), a separate 2-file hooks task (t-6), and `access.ts` deleted with the other auth code (t-7).
- **Why it matters:** the separate module lets the guard and its full Host table land in wave 1, independent of the data work. t-6 is below the "too small" threshold; merging it into t-7 (mvp's shape) is acceptable if the human prefers fewer tasks.

**4. ORIGIN: optional or removed, and what happens when it is unset.**
- **What each draft does.**
  - risk and mvp keep ORIGIN declared but optional.
  - verification removes the declaration, because adapter-node reads `process.env.ORIGIN` itself.
  - risk also claims that with ORIGIN unset, "self-origin follows Host". That is only half right: adapter-node 6.0.0 builds `https://<Host>` (handler.js:153). So with ORIGIN unset, every same-origin form POST from `http://127.0.0.1` fails Kit's CSRF check. Verification flags this; risk's t-18 restart test would hit it.
- **Default:** keep ORIGIN optional (risk+mvp). Apply verification's correction in t-12 and t-13, which spawn with ORIGIN set wherever they POST.
- **Why it matters:** 03-desktop-shell must set `ORIGIN=http://127.0.0.1:<port>` or the app cannot save anything. Keeping the declaration documents that. Removing it is equally valid for c-2.

**5. Proof level for c-1, c-2 and c-5.**
- **What each draft does.**
  - mvp proves c-5 with a vitest close/reopen, c-1 with a unit load plus "goto / stays on /" against the shared seeded preview, and c-2 by asserting that the webServer env lacks the secret.
  - risk and verification spawn `node build` with an env built from scratch. Their argument: Playwright's webServer merges `process.env`, so a developer's exported `BETTER_AUTH_SECRET` would mask c-2. Only a real process restart proves c-5.
- **Default:** spawn (t-13), keeping mvp's lib-level restart test as a unit backstop in t-5.
- **Why it matters:** t-13 and the node-server helper are the most fragile e2e pieces (ports, the win32 file lock, process exit). Without them, c-2 is only proven on a machine where the secret is not exported.

**6. Which server proves c-7 end to end.**
- **What each draft does.**
  - risk sends Host-override requests to the preview server.
  - verification says preview's `preview.allowedHosts` already 403s foreign Hosts, so that test passes with no hook, and uses `node build`.
  - mvp has no e2e for c-7 (unit only).
- **Default:** node build (verification), with risk's request matrix.
- **Why it matters:** a vacuous e2e would let a deleted or misordered hook ship green.

**7. Breadth of the c-6 CSRF proof.**
- **What each draft does.**
  - mvp tests 3 named actions, on the grounds that Kit's check is global.
  - risk and verification enumerate every action in an inventory, enforced by a vitest sync spec, so "any action" holds as actions are added. risk adds multipart, text/plain, Origin 'null' and no-Origin rows.
- **Default:** the inventory plus risk's content-type rows plus mvp's 400 control.
- **Why it matters:** this is one extra file and one spec, which buys protection against a future action being added without a CSRF row.

**8. How the footer is tested.**
- **What each draft does.**
  - risk renders `+layout.svelte` with svelte/server and mocked `$app/state` and `$app/paths`.
  - verification extracts a `SiteFooter.svelte` component and tests it in the browser project, avoiding the mocks.
  - mvp relies on `header.e2e` only.
- **Default:** verification's component spec, with "every page incl. 404" proven by e2e (t-11).
- **Why it matters:** the component spec cannot prove the layout actually renders the footer. That is left to e2e, which is outside the commit gate. risk's SSR spec would catch it in vitest at the price of brittle mocks.

**9. Upgrade-path guarantees for existing DBs.**
- **What each draft does.**
  - risk tests four things: no cascade on rebuild (R1); a two-user DB failing the migration and rolling back untouched (R2); journal ordering (R3); and NULL-config channels being deleted (R4).
  - mvp uses the generated migration as-is with no upgrade test, though it does reject dedup.
  - verification has no upgrade path at all (squash).
- **Default:** risk's tests, split across 0009 and 0010.
- **Why it matters:** without R1, a `DROP TABLE watch` rebuild that runs with foreign keys on would silently wipe price history and failures on any existing DB. The spec says multi-user DBs are "unsupported". Failing loudly (risk) and silently picking survivors are both readings of that word, and risk's is the only one any draft tests.

**10. Whether `no-public-signup.spec.ts` survives.**
- **What each draft does.**
  - mvp keeps it ("still passes with auth gone").
  - risk and verification delete it.
- **Evidence:** the spec asserts `keys` contains `/src/lib/server/auth-factory.ts`, so it goes red the moment auth-factory is deleted.
- **Default:** delete it in t-7, superseded by `removed-routes.spec`.
- **Why it matters:** keeping it would make t-7 uncommittable.

**11. Static assets and "every request".**
- **What each draft does.**
  - Only risk notes that adapter-node serves `/_app/immutable/*` via sirv before hooks, so those requests bypass the Host guard. It accepts the gap because those files hold no user data, and asserts the guard only on data-bearing paths.
  - mvp and verification claim "every path", but their tests also exercise only pages and /health.
- **Default:** accept the gap. t-12 asserts pages, `__data.json`, `/health` and actions.
- **Why it matters:** c-7 reads literally as "a request". If the human wants static assets covered too, that is new work (wrapping or replacing the adapter-node handler in 03), and none of the drafts plans it.

**12. e2e ordering and leftovers.**
- **What each draft does.**
  - risk rebuilds the seed in wave 2, right after the schema change. But that task drops `BETTER_AUTH_SECRET` from the webServer env while `env.ts` still requires it, so the e2e server can't boot until t-15.
  - mvp rebuilds the seed right after auth deletion.
  - verification rebuilds it after the env task.
  - risk ports `page.svelte.e2e.ts`; mvp and verification delete it. It contains only "demo sign-up page is gone".
- **Default:** seed after the env task (verification), and delete `page.svelte.e2e.ts`.
- **Why it matters:** e2e is red regardless until wave 6–7. Ordering it after t-8 means it is rebuilt once against the final env and schema rather than chasing intermediate states. The cost is that no e2e signal exists until late in the phase.
