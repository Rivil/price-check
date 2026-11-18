# Architecture

This document describes what the system _does_, organized by feature — one entry
per user-facing capability, never one per phase and never one per module. Read it
top-to-bottom to learn the capabilities; follow the symbol links to find the code.

Every entry follows one fixed template:

### <Feature name — a user-facing capability, not a module or a phase>

<One line: what this capability does.>

- Symbol.Name — path/to/file.ext:line
- Another.Symbol — path/to/other.ext:line

_introduced <phase-id> · extended <phase-id> · <short-sha>_

Entries are maintained automatically: dross-ship merges each phase's landmarks
into the matching feature entry (updating in place), and /dross-architecture can
regenerate the whole document from a scan of the code and git history.

<!-- entries below, alphabetical by feature -->

### Access control

Every request, /health included, must be addressed to a loopback Host (localhost or 127.0.0.1, any port) or gets a plain 403 before any route runs, and Kit's CSRF origin check rejects cross-origin form POSTs; there is no sign-in and no session. In the desktop app, a node:http wrapper listens on 127.0.0.1 only, on an OS-assigned port, 403s a non-loopback Host before any asset or route (/_app/immutable/* included), and hands the request on as plain http so the window's own form posts pass the origin check.

- isLoopbackHost — src/lib/server/local-request.ts:11
- createLocalRequestHandle — src/lib/server/local-request.ts:28
- handle — src/hooks.server.ts:37
- ACTION_ENDPOINTS — e2e/action-endpoints.ts:9
- startDesktopServer — src/desktop/server.ts:76
- forcePlainHttp — src/desktop/server.ts:53
- guard in the app window — e2e/desktop/guard.e2e.ts:105

_introduced accounts · 8be9d9c · extended health · a1e390e · extended 02-single-user · 7d337c3 · extended 03-desktop-shell · e6b1e47_

### Accessibility checks

Playwright checks every page, in light and dark, for axe AA text contrast, 3:1 control borders, and a ≥2px, ≥3:1 focus-visible outline on every keyboard stop.

- expectTextContrast — e2e/a11y.ts:61
- expectState — src/routes/contrast.e2e.ts:127
- PAGES — src/routes/focus.e2e.ts:37

_introduced app-design · 3f93e57_

### Alert channel credential encryption

Channel settings are stored under AES-256-GCM with a dedicated ALERTS_ENCRYPTION_KEY bound to the channel kind; the server refuses to start without a valid key and names only the variable.

- encryptSecret — src/lib/server/alerts/crypto.ts:70
- init — src/hooks.server.ts:27

_introduced alert-channels · 70c444a_

### Alert channel drivers

Each channel type implements one driver contract (parse config, view, send) that reports text-free failure reasons; ntfy sends drops at priority 5 and failed checks at 2, without following redirects; Resend emails through the user's own key to api.resend.com only, classifying failures by status and error name, with a fixed domain hint on a 403 validation_error; SMTP logs in to the user's own server with TLS chosen by port (465 implicit, else required STARTTLS) and certificates always verified, maps failures from reply codes and error fields only (534/535 on AUTH adds an app-password hint), and destroys the socket when the overall deadline wins.

- ChannelDriver — src/lib/server/alerts/channel.ts:69
- resendDriver — src/lib/server/alerts/resend.ts:96
- smtpDriver — src/lib/server/alerts/smtp.ts:208
- startSmtpServer — src/lib/server/testing/smtp-server.ts:112
- overall deadline — src/lib/server/alerts/smtp.spec.ts:308

_introduced alert-channels · 31dc98b · extended resend-channel · 01c0e9b · extended smtp-channel · af1ed7b_

### Alert channel settings

Account → Alerts shows one card per channel type (ntfy, Resend, SMTP) with per-kind routing, enable/disable, Send test with its failure reason and remove; a new card starts with its type's default routing (the email cards' recipient empty, SMTP's port 587), credentials are write-only, non-text form fields are ignored, and each card's messages show only in that card.

- load — src/routes/account/alerts/+page.server.ts:52
- channel-resend card — src/routes/account/alerts/+page.svelte:171
- channel-smtp card — src/routes/account/alerts/+page.svelte:236
- file token — src/routes/account/alerts/page.server.spec.ts:359
- disabled channel keeps its topic — src/routes/account/alerts/page.svelte.spec.ts:44

_introduced alert-channels · 2901b1c · extended resend-channel · bc62f8a · extended smtp-channel · 4e45454_

### Alert channels storage

One encrypted channel per kind with write-only secrets and per-watch, per-channel price-drop delivery rows; the legacy plaintext topic store is gone.

- notifyChannel — src/lib/server/db/channel.schema.ts:14
- saveChannel — src/lib/server/alerts/channels.ts:176

_introduced alert-channels · d9672c0_

### At-target price highlight

A successful price at or below the watch's target shows in the ok colour, with a visible "at or below target" label, on the watchlist and on the watch page.

- isAtOrBelowTarget — src/lib/watch-view.ts:54

_introduced app-design · 2a203f3_

### Auto-update

A packaged install checks GitHub Releases at launch and every 6 hours, downloads in the background, then shows one notification per version and a tray 'Restart to update' item; Quit or Restart installs only after the database closes, never by force, an rc install takes the final release but a final never takes an rc, and the relaunched version waits for the old process to exit before opening the database.

- createUpdater — src/desktop/updater.ts:115
- installOnExit — src/desktop/updater.ts:221
- installPending — src/desktop/lifecycle.ts:263
- watchSquirrel — src/desktop/lifecycle.ts:283

_introduced 05-release · 4a43cac · extended 05-release · 89db383_

### Check failure history

Every failed check and failed first add stores its own check_failure row atomically, and migration 0006 backfills each watch's current failure; failureHistory reads them newest first.

- checkFailure — src/lib/server/db/check-failure.schema.ts:8
- failureHistory — src/lib/server/checks.ts:154

_introduced price-chart · 042974d_

### Continuous integration

Public CI runs tests, typecheck, lint, the web e2e suite and the Electron desktop e2e suite on Linux, macOS and Windows (Linux under xvfb with the AppArmor user-namespace restriction lifted), with the Electron download cached before install; every PR also packages an unsigned app per OS, verifies its layout, runs the packaged smoke and, on Windows and Linux, the update e2e, and specs pin the workflows through a no-YAML-library line reader.

- desktop e2e — .github/workflows/ci.yml:137
- package step — .github/workflows/ci.yml:165
- readWorkflow — scripts/workflow-reader.ts:164

_introduced 03-desktop-shell · 79bbc38 · extended 05-release · 4152909_

### Design tokens

Every page takes its colours (light and dark), type and spacing from shared tokens and token-only base styles; a source scan fails on any colour literal outside tokens.css.

- parseTokens — src/lib/styles/tokens.ts:124
- base.css — src/lib/styles/base.css:1

_introduced app-design · ae4d978_

### Desktop app window

The app window is sandboxed on the local origin and never leaves it: window.open is always denied, off-origin http(s) links open in the default browser, and off-origin navigations and redirects are prevented; showing the window restores it or creates a new one, optionally on a same-origin path (an off-app path falls back to the origin, and a live window is never reloaded without one).

- createMainWindow — src/desktop/window.ts:110
- showWindow — src/desktop/window.ts:165

_introduced 03-desktop-shell · 453d539 · extended 03-desktop-shell · 68af770 · extended 04-desktop-notify · b94c08d_

### Desktop background running

The desktop app keeps running in the tray after its window closes: a single-instance lock refocuses the running app, a resume from sleep runs one scheduler pass at once, and Quit stops the scheduler, server and database within a deadline before exiting; the tray offers Open, Start at login and Quit.

- runDesktop — src/desktop/lifecycle.ts:172
- createTray — src/desktop/tray.ts:80
- publishRuntime — src/lib/server/runtime-bridge.ts:21
- runDesktop wiring — src/desktop/main.ts:76

_introduced 03-desktop-shell · 40cba9a · extended 03-desktop-shell · e7f79f2_

### Desktop build

esbuild bundles the Electron main process to dist-desktop/main.js and refuses any $app, libsql or drizzle-orm/libsql import, so the server stays in the adapter-node build.

- buildDesktop — scripts/build-desktop.ts:80
- REFUSED — scripts/build-desktop.ts:34

_introduced 03-desktop-shell · 981d0d9 · extended 03-desktop-shell · 2674302_

### Desktop first launch

A first launch on an empty userData dir opens the empty watchlist with no setup: the database lives in userData and a 32-byte alerts key is created once (0600 on POSIX) and never regenerated, so saved channel credentials survive relaunches.

- loadOrCreateAlertsKey — src/desktop/alerts-key.ts:97
- quitThroughApp — e2e/desktop/quit-relaunch.e2e.ts:47

_introduced 03-desktop-shell · 40971db · extended 03-desktop-shell · 42f96b3_

### Desktop notifications

The desktop app shows price drops (and, when ticked, failed checks) as native notifications through a seeded Desktop channel that starts on and cannot be removed; a watch notifies once per target reached, a click opens the app window on that watch (or the watchlist if it is gone), Send test reports an unsupported OS as a failure, and Windows sets the shared AppUserModelId before any notification.

- readNotifier — src/lib/server/notify-bridge.ts:33
- createNotifier — src/desktop/notifier.ts:70
- notificationClassFor — src/desktop/notify-seam.ts:116
- createDesktopDriver — src/lib/server/alerts/desktop.ts:42
- ensureChannel — src/lib/server/alerts/channels.ts:221
- setUpDesktopAlerts — src/hooks.server.ts:24
- runDesktop — src/desktop/lifecycle.ts:172
- KEPT_KINDS — src/routes/account/alerts/+page.server.ts:44
- recordedNotifications — e2e/desktop/launch.ts:423
- saveTicks — e2e/desktop/desktop-alerts.e2e.ts:87

_introduced 04-desktop-notify · 3b59163 · extended 04-desktop-notify · 15c2572_

### Desktop packaging

electron-builder packages one universal macOS app (dmg and zip), a per-user Windows x64 NSIS installer and a Linux x64 AppImage, with libsql's native binaries (both darwin arches) unpacked outside app.asar and the server run from app.asar.unpacked; local and PR packaging never publishes and signs only through a --sign credential gate.

- supportedArchitectures — pnpm-workspace.yaml:7
- builderConfig — scripts/package-desktop.ts:167
- serverCwdFor — src/desktop/app-paths.ts:40

_introduced 05-release · bf9ebbc_

### Docs checks

A spec pins the README's end-user-first shape and per-OS install notes and fails on auth-stack traces in the docs, package.json or src, and on multi-user leftovers in this document.

- staleArchitecture — scripts/readme.spec.ts:33
- osPart — scripts/readme.spec.ts:77

_introduced 01-public-ci · 19df497 · extended 02-single-user · 00118d3 · extended 05-release · efe0cbc_

### E2E test harness

Playwright runs against a freshly migrated database seeded with one install's data (watches with long content, chart and card watches timed relative to seeding, failures and an ntfy channel, no accounts) built and previewed before the suite; node-build specs spawn the built server with an allowlisted env and stop it without the 30s drain; desktop specs launch real Electron through Playwright on a temp userData, seed through a child process, and kill the process tree on Windows.

- webServer — playwright.config.ts:12
- SEEDED_DESIGN_TOPIC_URL — e2e/accounts.ts:24
- chartFull — e2e/accounts.ts:181
- startNodeServer — e2e/node-server.ts:80
- startNodeServer.stop — e2e/node-server.ts:139
- launchDesktop — e2e/desktop/launch.ts:310

_introduced accounts · 62effc6 · extended app-design · 5944cfe · extended price-chart · 54fd517 · extended 02-single-user · 93a5f70 · extended 03-desktop-shell · 84ac028_

### Failed-check alerts

A failed check tells every enabled failures channel in parallel, every time, with no claim and no retry; a channel this install's key cannot decrypt is logged by kind and skipped while the others are still told, and the check never fails.

- alertAfterFailure — src/lib/server/alerts/alerts.ts:205
- undecryptable channel — src/lib/server/alerts/alerts.spec.ts:973

_extended 02-single-user · aa810e8_

### Header and footer

Every page shows a header with Watchlist and Alerts only (the current link marked with aria-current, no sign-in chrome) and a footer Source link to the public repo (AGPL-3.0 §13).

- navItems — src/lib/nav.ts:29
- Main nav — src/routes/+layout.svelte:25
- SiteFooter — src/lib/components/SiteFooter.svelte:9
- source link on every page — src/routes/header.e2e.ts:48

_introduced app-design · 2f29576 · extended 02-single-user · 32275bd_

### Health probe

A public GET /health reads every schema table and answers 200 or 503 with no detail, retrying a locked database for about 1s.

- healthResponse — src/lib/server/health.ts:53
- retry deadline — src/lib/server/health.spec.ts:137

_introduced health · 8bb016d_

### Packaged app checks

verify-packaged checks a packaged build's app.asar file set, unpacked per-OS libsql, stamped versions and latest*.yml files, the macOS universal slices and signing, and the Windows per-user install and AUMID; the packaged smoke launches the real app on a guarded temp home and checks the empty watchlist, libsql outside asar, a watch persisting across relaunch and the x64 slice.

- verifyLayout — scripts/verify-packaged.ts:493
- verifyWin — scripts/verify-packaged.ts:190
- locate — scripts/packaged-app.ts:133
- launchPackaged — e2e/packaged/launch-packaged.ts:290

_introduced 05-release · 5367b21 · extended 05-release · b0f3189_

### Packaged update tests

On Windows and Linux an installed build A updates from a 127.0.0.1-only feed serving a newer build B, and the test proves the download, one notification, install on quit and B's relaunch after A exits with its data intact, finding B by its own serving port; a failed step attaches the app's captured output and per-OS process state.

- packaged update — e2e/packaged/update.packaged.ts:370
- startUpdateFeed — scripts/update-feed.ts:166
- replaceExecutable — scripts/packaged-app.ts:184
- servingPort — scripts/process-probe.ts:480
- isAppImageApp — scripts/process-probe.ts:310
- osState — e2e/packaged/update.packaged.ts:325
- startOutputCapture — src/desktop/main.ts:119

_introduced 05-release · be5d71a · extended 05-release · f3e92eb_

### Price chart

The watch page draws price and failure marks on a true time axis with 30-day, 90-day and all-time ranges, roving-focus marks and a nearest-mark tooltip.

- chartView — src/lib/chart.ts:62
- PriceChart — src/lib/components/PriceChart.svelte:1
- chart marks contrast — src/routes/contrast.e2e.ts:187
- expectStructure — e2e/a11y.ts:105

_introduced price-chart · 1a95d5a_

### Price-drop alerts

A check at or below target sends each drop once to every enabled drops channel, retries only the channels that failed, and re-arms when the price rises above target or the target changes.

- alertAfterSuccess — src/lib/server/alerts/alerts.ts:130
- setTarget — src/lib/server/watches.ts:151
- ntfy and resend — src/lib/server/alerts/alerts.spec.ts:615
- ntfy, resend and smtp — src/lib/server/alerts/alerts.spec.ts:711

_introduced push-alerts · extended alert-fixes · extended alert-channels · 5a13e00 · extended resend-channel · 94d2351 · extended smtp-channel · a6450c5_

### Release publishing

Pushing a v* tag on a main commit whose version matches package.json builds and smoke-tests all three OSes, then one gh-only job holding the workflow's sole contents: write publishes a single GitHub Release (a pre-release for -rc.N) with every artefact at once, refusing an existing release; any failed build, wrong tag or missing Apple credential publishes nothing.

- checkReleaseTag — scripts/release-tag.ts:38
- WRITE_SCOPE_ALLOWLIST — scripts/workflow-policy.ts:25

_introduced 05-release · 61c138b · extended 05-release · 0d932af_

### Responsive layout

Pages sit in a centred 44rem column and never scroll sideways at 375px, even with long titles, URLs and account names.

- check375 — src/routes/layout.e2e.ts:78

_introduced app-design · cadd0fa_

### Secret-safe error logging

Server and scheduler errors log only their type, route or watch id, and real stack frames, so message text such as a topic URL or token never reaches the log.

- formatError — src/lib/server/error-log.ts:42
- frames — src/lib/server/error-log.ts:23
- handleError — src/hooks.server.ts:46

_introduced alert-fixes · d00d0dc_

### Single-user install

One install owns all data with no accounts, sign-in or admin: / opens straight on the watchlist, only DATABASE_URL and ALERTS_ENCRYPTION_KEY are required, the removed auth routes are plain 404s, and watches (unique per shop and product) and channels (one per kind) survive a restart.

- addWatch — src/lib/server/watches.ts:54
- variables — src/env.ts:3
- 0011_drop_auth — drizzle/0011_drop_auth.sql:1
- opens without login — src/routes/watchlist.e2e.ts:26
- data survives a restart on the same database — e2e/restart.e2e.ts:52

_introduced 02-single-user · 4d5a234_

### Start at login

A packaged first launch registers the app to start at login once (Electron's login item on macOS and Windows, an XDG autostart entry on Linux) and never re-asserts it; a login launch shows only the tray, and the tray's toggle reads and writes the OS state.

- createLoginItem — src/desktop/login-item.ts:115
- autostartEntry — src/desktop/login-item.ts:94

_introduced 03-desktop-shell · 2df5492 · extended 03-desktop-shell · 5556161_

### Test database harness

Unit tests get a freshly migrated temp-file SQLite per call; dispose() closes the client and removes its directory.

- createTestDb — src/lib/server/testing/test-db.ts:24

_introduced 02-single-user · c5fd8f4_

### Watch page history

The watch page shows one newest-first timeline of prices and failures, ever-stats and the chart from one captured now, or says there is no successful check.

- timeline — src/lib/watch-history.ts:30
- priceStats — src/lib/watch-history.ts:61
- load — src/routes/watches/[id]/+page.server.ts:14
- PriceChart — src/routes/watches/[id]/+page.svelte:60

_introduced price-chart · a56d54a_

### Watchlist cards

Each card says when its watch was checked and is next due, reading overdue only past a one-hour grace, and draws a 30-day sparkline or says why it has none.

- checkStatus — src/lib/watch-view.ts:73
- sparkline — src/lib/sparkline.ts:25
- recentPrices — src/lib/server/sparklines.ts:8
- load — src/routes/+page.server.ts:33

_introduced price-chart · 76ac1dd_
