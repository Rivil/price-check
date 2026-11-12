# Panel draft: MVP lens

```
Phase 02-single-user — 6 tasks across 4 waves

Wave 1
  t-1  Drop user_id from all data tables
       files:    src/lib/server/db/watch.schema.ts, src/lib/server/db/channel.schema.ts,
                 src/lib/server/db/schema.ts, src/lib/server/db/alert.schema.ts (delete),
                 drizzle/0009_single_user_data.sql (new), drizzle/meta/0009_snapshot.json (new),
                 drizzle/meta/_journal.json,
                 src/lib/server/watches.ts, src/lib/server/checks.ts, src/lib/server/sparklines.ts,
                 src/lib/server/alerts/alerts.ts, src/lib/server/alerts/channels.ts,
                 src/lib/server/alerts/crypto.ts, src/lib/server/alerts/backfill.ts (delete),
                 src/hooks.server.ts, src/routes/+page.server.ts,
                 src/routes/watches/[id]/+page.server.ts, src/routes/account/alerts/+page.server.ts,
                 src/lib/server/testing/test-db.ts (new),
                 specs: src/lib/server/{watches,checks,sparklines,scheduler,health}.spec.ts,
                 src/lib/server/alerts/{alerts,channels,live,crypto}.spec.ts,
                 src/lib/server/alerts/backfill.spec.ts (delete),
                 src/lib/server/db/{watch,channel,check-failure,price-point}.schema.spec.ts,
                 src/lib/server/db/alert.schema.spec.ts (delete), src/lib/server/db/migrate.spec.ts,
                 src/hooks.server.spec.ts, src/routes/page.server.spec.ts,
                 src/routes/watches/[id]/page.server.spec.ts, src/routes/account/alerts/page.server.spec.ts
       desc:     Remove user_id (and the user FK/indexes) from watch, notify_channel and
                 price_drop_delivery via one drizzle-kit-generated rebuild migration; drop the
                 legacy alert_channel table and its startup backfill. Every lib function loses its
                 userId param; watch uniqueness becomes (shop, product_id); notify_channel PK becomes
                 kind; channelAad(kind). Routes stop reading locals.user. Specs move off
                 auth-harness to a plain migrated temp-file DB helper (test-db.ts).
       covers:   c-5, c-1
       contract: migrate.spec 'restart keeps data': on a temp file DB, addWatch (stub shop) +
                 recordCheck price point + saveChannel, close the client, createDb + migrateDb on the
                 same file → listWatches, priceHistory and listChannels return all three rows (c-5);
                 migrate.spec: after a fresh migrate, PRAGMA table_info on watch, notify_channel and
                 price_drop_delivery has no user_id column and sqlite_master has no alert_channel;
                 watches.spec: a second addWatch of the same (shop, productId) returns the existing
                 watch, not a UNIQUE error (PRODUCT_RACE regex matches watch.shop, watch.product_id);
                 crypto.spec: a config sealed with channelAad('ntfy') fails to open under
                 channelAad('smtp');
                 page.server.spec: load({}) with no locals.user on a freshly migrated DB returns
                 { watches: [] } instead of throwing 401 (c-1);
                 hooks.server.spec: init order is ['key','migrated','scheduler'] (backfill gone)
       depends:  —

  t-2  Strip header auth links, add Source footer
       files:    src/routes/+layout.svelte, src/routes/+layout.server.ts (delete),
                 src/routes/layout.server.spec.ts (delete), src/lib/nav.ts, src/lib/nav.spec.ts,
                 src/routes/header.e2e.ts
       desc:     Header always renders (no data.nav gate) with Watchlist + Alerts only; remove the
                 Sign out form, Account and Admin items and the isAdmin input. Add a footer with a
                 'Source' link to https://github.com/Rivil/price-check in the root layout.
       covers:   c-4
       contract: nav.spec: navItems({ pathname: '/' }) returns exactly [Watchlist '/', Alerts
                 '/account/alerts'] — re-adding Account or Admin fails it;
                 header.e2e: on /, /watches/e2e-page-detail, /account/alerts and /no-such-page the
                 footer link named 'Source' has href exactly https://github.com/Rivil/price-check,
                 and the header has no 'Sign out' button and no 'Admin' link
       depends:  —

Wave 2 (depends t-1, t-2)
  t-3  Delete auth; gate requests by loopback Host
       files:    src/lib/server/access.ts, src/lib/server/access.spec.ts, src/hooks.server.ts,
                 src/hooks.server.spec.ts, src/app.d.ts, src/lib/server/db/schema.ts,
                 drizzle/0010_drop_auth.sql (new), drizzle/meta/0010_snapshot.json (new),
                 drizzle/meta/_journal.json, src/lib/server/db/migrate.spec.ts,
                 delete: src/lib/server/db/auth.schema.ts, src/lib/server/auth.ts,
                 src/lib/server/auth-factory.ts (+spec), src/lib/server/accounts.ts (+spec),
                 src/lib/server/admin-bootstrap.ts (+spec), src/lib/server/login-limiter.ts (+spec),
                 src/lib/server/own-password.ts (+spec), src/lib/server/cli/admin-create.ts,
                 src/lib/server/testing/auth-harness.ts, src/routes/login/, src/routes/logout/,
                 src/routes/account/password/, src/routes/admin/
       desc:     Rewrite access.ts from the session gate into a Host-header loopback guard (reads
                 request.headers 'host', never event.url, which ORIGIN can mask); handle = that guard
                 alone, applied to every path including /health. Remove svelteKitHandler, the
                 session load and Locals.user/session. Delete all auth libs, routes and the
                 user/session/account/verification tables (second generated migration).
       covers:   c-1, c-3, c-7
       contract: access.spec: Host 'localhost', 'localhost:4173', '127.0.0.1', '127.0.0.1:61234'
                 resolve; 'evil.test', 'localhost.evil.test', '127.0.0.1.nip.io', '[::1]:4173' and a
                 missing Host return 403 without calling resolve (c-7);
                 hooks.server.spec: handle on GET /health with Host 'attacker.test' → 403 and resolve
                 never called (guard covers /health); handle on GET / with Host 'localhost' and no
                 cookie calls resolve once and throws no redirect (c-1);
                 migrate.spec: after a fresh migrate sqlite_master has no user, session, account or
                 verification table; schema.ts exports no `user`.
                 c-3's 404s are asserted end-to-end in t-5
       depends:  t-1, t-2

Wave 3 (depends t-3)
  t-4  Drop BETTER_AUTH_SECRET, better-auth deps and docs
       files:    src/env.ts, src/env.spec.ts, package.json, pnpm-lock.yaml, .env.example,
                 README.md, scripts/readme.spec.ts
       desc:     Remove the BETTER_AUTH_SECRET declaration and make ORIGIN optional (passthrough
                 schema) so only DATABASE_URL and ALERTS_ENCRYPTION_KEY are needed; pnpm remove
                 better-auth and auth; drop admin:create/auth:schema scripts; strip the secret and
                 admin:create steps from .env.example and README.
       covers:   c-2
       contract: env.spec: Object.keys(variables) has no BETTER_AUTH_SECRET, and every declared
                 variable except DATABASE_URL validates `undefined` (re-adding a required ORIGIN or
                 secret fails it);
                 readme.spec: README and .env.example contain neither BETTER_AUTH_SECRET nor
                 admin:create, and package.json has no better-auth dependency
       depends:  t-3

  t-5  Rebuild e2e seed and no-auth checks
       files:    e2e/seed.ts, e2e/accounts.ts, playwright.config.ts, e2e/harness.e2e.ts,
                 src/routes/local-only.e2e.ts (new)
       desc:     Seed watches/history with no users (drop owner, other-user watch and legacy
                 alert_channel; seed the design ntfy channel via saveChannel). Remove signIn,
                 credentials and E2E_SECRET from accounts.ts; webServer env drops BETTER_AUTH_SECRET
                 and ORIGIN. New spec for direct access, removed routes and CSRF.
       covers:   c-1, c-2, c-3, c-6
       contract: local-only.e2e 'no login': page.goto('/') ends on pathname '/' with the
                 watchlist heading visible (c-1);
                 local-only.e2e 'removed routes': GET /login, /logout, /account/password,
                 /admin/users, /admin/users/x/password, /api/auth/get-session and POST /logout,
                 POST /api/auth/sign-in/email each return 404 (c-3);
                 local-only.e2e 'csrf': form POSTs to /?/add, /watches/e2e-page-edit?/delete and
                 /account/alerts?/remove with Origin https://evil.example return 403 and the watch
                 still exists; the same /?/add POST with Origin http://localhost:4173 and an
                 unsupported URL returns 400, not 403 (c-6, no live fetch, r-01);
                 harness.e2e 'server env': playwright webServer.env has no BETTER_AUTH_SECRET or
                 ORIGIN key — and the preview server serving every e2e spec proves it starts
                 without them (c-2)
       depends:  t-3

Wave 4 (depends t-5)
  t-6  Remove sign-in from remaining e2e specs
       files:    src/routes/watchlist.e2e.ts, src/routes/watches/[id]/watch-page.e2e.ts,
                 src/routes/account/alerts/alerts.e2e.ts, src/routes/layout.e2e.ts,
                 src/routes/contrast.e2e.ts, src/routes/focus.e2e.ts, src/routes/at-target.e2e.ts,
                 src/routes/chart-a11y.e2e.ts, src/routes/page.svelte.e2e.ts (delete)
       desc:     Drop signIn imports/beforeEach and go straight to each page; delete cross-user
                 ('only mine') and admin-table/login-page cases; fix card counts now that all seeded
                 watches share one list.
       covers:   c-1
       contract: watchlist.e2e 'list' loads / with no sign-in step and finds 'E2E Listed Kettle';
                 watch-page.e2e loads /watches/e2e-page-detail directly and shows its history;
                 alerts.e2e loads /account/alerts directly and shows the seeded design topic —
                 any reintroduced login redirect fails all three
       depends:  t-5
```

## Coverage

| Criterion | Tasks |
|---|---|
| c-1 empty watchlist directly, no login | t-1 (load on fresh DB → []), t-3 (handle never redirects), t-5 (goto / stays on /), t-6 (every page reached directly) |
| c-2 starts without BETTER_AUTH_SECRET | t-4 (env declarations), t-5 (e2e server env without it) |
| c-3 removed routes 404 | t-3 (deletion + svelteKitHandler removal), t-5 (404 assertions) |
| c-4 no Sign out/Admin, Source footer | t-2 |
| c-5 data survives restart | t-1 |
| c-6 foreign-Origin form POST → 403 | t-5 |
| c-7 non-loopback Host → 403 | t-3 |

7/7 criteria covered.

## Judgment calls

- **t-1 is one oversized atomic task**, chosen over a channels-first/watches-second split: dropping user_id changes every data-layer signature and its route callers at once, and the split would edit six shared specs twice (scheduler, alerts, live, migrate, two route specs) and produce two migrations. If the judge needs smaller tasks, the only green boundary is notify_channel/price_drop_delivery first, then watch.
- **Two migrations (0009 data, 0010 auth tables)**, not one: the auth tables can only be dropped once better-auth code and its specs are gone (t-3), and the data specs need the unscoped schema before that. One migration would force t-1 and t-3 into a single ~60-file task.
- **Delete alert_channel and backfill.ts**, not adapt them: the legacy table's PK is user_id, and it only exists to upgrade old server installs, which the milestone excludes. Deleting is less work than rekeying.
- **Generated migration is used as-is** (plain INSERT…SELECT rebuild). I did not add INSERT OR IGNORE dedup for multi-user DBs. The locked decision says multi-user DBs are unsupported, and no desktop installs exist. Existing notify_channel ciphertexts stop decrypting under the new AAD, which is acceptable for the same reason.
- **access.ts is rewritten into the Host guard**, not given a new module next to it: it is already "the request gate" wired in hooks, so this avoids a new file and a dead one. The guard reads the Host header, not event.url, because adapter-node rewrites url from ORIGIN.
- **ORIGIN is made optional, not deleted.** It is declared without a schema today, so it is required and would break c-2. adapter-node still reads it if set, so keeping it as an optional declaration costs nothing.
- **No CSRF code task.** SvelteKit's origin check is already on (vite.config.ts sets no csrf option), so c-6 needs only the e2e proof in t-5, against the preview build where Kit enforces it.
- **c-5 is proved in vitest (migrate.spec close/reopen) rather than an e2e server restart**: it is the same file-DB guarantee without a second webServer lifecycle in Playwright.
- **c-1's "fresh database" is asserted at unit level** (load on a fresh migrated DB, and a hooks handle that never redirects). The e2e only shows / is reached directly, because the shared seeded DB is never fresh. I rejected a second e2e server just for an empty DB.
- **e2e fixtures (seed/accounts) are rebuilt once in t-5**, not patched in t-1. e2e/ is outside tsconfig's include and only runs at phase end/CI, so intermediate commits can leave e2e red without breaking the vitest/lint gate. Touching seed twice buys nothing.
- **header.e2e.ts lives in t-2**, with the footer it tests. t-6 handles only the mechanical sign-in removal elsewhere, split from t-5 because it touches 9 files.
- **Left out as untraceable:** ARCHITECTURE.md auth prose (already deferred debt), deleting no-public-signup.spec.ts (it still passes with auth gone), and any accounts.ts → fixtures.ts rename.
