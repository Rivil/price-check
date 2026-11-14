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

Every request, /health included, must be addressed to a loopback Host (localhost or 127.0.0.1, any port) or gets a plain 403 before any route runs, and Kit's CSRF origin check rejects cross-origin form POSTs; there is no sign-in and no session.

- isLoopbackHost — src/lib/server/local-request.ts:11
- createLocalRequestHandle — src/lib/server/local-request.ts:28
- handle — src/hooks.server.ts:37

_introduced accounts · 8be9d9c · extended health · a1e390e · extended 02-single-user_

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

### Alert channels upgrade

On startup, legacy plaintext ntfy rows are copied into encrypted channels without overwriting a re-saved one, then deleted and VACUUMed so no topic or token stays in the DB file.

- backfillLegacyNtfy — src/lib/server/alerts/backfill.ts:26

_introduced alert-channels · affb2b3_

### At-target price highlight

A successful price at or below the watch's target shows in the ok colour, with a visible "at or below target" label, on the watchlist and on the watch page.

- isAtOrBelowTarget — src/lib/watch-view.ts:54

_introduced app-design · 2a203f3_

### Check failure history

Every failed check and failed first add stores its own check_failure row atomically, and migration 0006 backfills each watch's current failure; failureHistory reads them newest first.

- checkFailure — src/lib/server/db/check-failure.schema.ts:8
- failureHistory — src/lib/server/checks.ts:154

_introduced price-chart · 042974d_

### Design tokens

Every page takes its colours (light and dark), type and spacing from shared tokens and token-only base styles; a source scan fails on any colour literal outside tokens.css.

- parseTokens — src/lib/styles/tokens.ts:124
- base.css — src/lib/styles/base.css:1

_introduced app-design · ae4d978_

### E2E test harness

Playwright runs against a freshly migrated database seeded with one install's data (watches with long content, chart and card watches timed relative to seeding, failures and an ntfy channel, no accounts) built and previewed before the suite.

- webServer — playwright.config.ts:12
- SEEDED_DESIGN_TOPIC_URL — e2e/accounts.ts:24
- chartFull — e2e/accounts.ts:181

_introduced accounts · 62effc6 · extended app-design · 5944cfe · extended price-chart · 54fd517_

### Header navigation

Every page shows a header with Watchlist and Alerts; the current link is marked with aria-current.

- navItems — src/lib/nav.ts:29
- Main nav — src/routes/+layout.svelte:25

_introduced app-design · 2f29576 · extended 02-single-user_

### Health probe

A public GET /health reads every schema table and answers 200 or 503 with no detail, retrying a locked database for about 1s.

- healthResponse — src/lib/server/health.ts:53
- retry deadline — src/lib/server/health.spec.ts:137

_introduced health · 8bb016d_

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
