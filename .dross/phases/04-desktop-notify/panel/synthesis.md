# 04-desktop-notify: panel synthesis

Judge: cold, authored none of the drafts. Claims checked against source on 2026-11-14:
- `channelsFor` skips `config_enc IS NULL` rows, and `loadChannelConfig` returns null for them. The Alerts page `?/test` then answers "Save this channel first." (channels.ts, +page.server.ts).
- `ChannelDriver.kind` is typed `ChannelKind`, so `'desktop'` has to join that union before a desktop driver type-checks.
- `REASON_LABELS` is a `Record<FailureReason, string>` in channel.ts, and ntfy.spec.ts has its own `Record<FailureReason, string>` labels table. Adding `'unsupported'` leaves `pnpm check` red unless both gain the entry. vitest and lint stay green either way. No draft lists ntfy.spec.ts.
- `createMainWindow` always calls `loadURL(origin)`, so a path-carrying new window needs a URL parameter there. Otherwise it loads twice.
- Only `runtime-bridge.ts` uses `Symbol.for('price-check.runtime')`. `fake-handler.ts` already records env and cwd at import time, which is the pattern the publish-before-import contract reuses.
- `checkWatch` awaits afterSuccess/afterFailure (checks.ts:112-113). The watch page's `?/check` wires `liveAfterSuccess`/`liveAfterFailure`. `checkNow` refuses a check within 15 min of that watch's `lastCheckedAt` (per-watch cooldown).
- ci.yml runs `pnpm test:e2e:desktop` on ubuntu-24.04 (`xvfb-run -a`), macos-15 and windows-2025. playwright.desktop.config.ts matches `e2e/desktop/**/*.e2e.ts`, so no workflow edit is needed.
- `INHERITED_ENV` in e2e/desktop/launch.ts carries no `DBUS_SESSION_BUS_ADDRESS`. A real Linux notification in e2e cannot reach a daemon.
- `.gitleaks.toml` allowlists tests.json for 01–03 only.

## Scores

| Draft | Criteria coverage | Test-contract specificity | Granularity | Wave correctness (vitest+lint gate per commit) |
|---|---|---|---|---|
| risk | 6/6. Covers c-2's quit, pre-ready and tray-only click paths and c-6 ordering. e2e covers c-4 relaunch only for "off", not for the untick stopping sends | High. Exact paths (`'/watches/a%2Fb%3Fc'`), an off-origin path table, `vi.getTimerCount()===0`, a concurrent seed, a retention cap and a call-order log | Good. 10 tasks, each owns one failure mode, ≤5 files except t-2 | Flawed in one place. Wave 1 runs t-1..t-4 in parallel, but the gitleaks fix sits only in t-1 and the rest have no depends_on, so "commit first" is prose the executor can ignore. Deps and file ownership are otherwise clean. Lifecycle+main land together |
| mvp | 6/6 nominally. c-2 has no quit or pre-ready guard: main.ts sends clicks straight to showWindow and bypasses the lifecycle. c-6 holds "by construction" with no ordering test | Medium. Concrete amounts and paths, but `'Not delivered: unsupported.'` is weak copy, and nothing tests that the publish precedes the handler import or covers retention cap or timers | Coarse. 4 tasks: t-1 has 8 files and 5 criteria, t-3 has 7 files, and one red hides several failure surfaces | Correct. t-1 is the only wave-1 task and carries gitleaks. Wave 2 tasks share no file |
| verification | 6/6, strongest e2e. Untick, off, relaunch and unsupported run in real Electron, plus a real-Notification smoke per OS | High. Exact copy and amounts, delivery_result split into retry and no-flood, publish-before-import as a vitest contract via fake-handler, AUMID throw handling | Mixed. 9 tasks, but t-7 has 8 files and lifecycle.ts/main.ts are edited by two tasks (t-2 then t-7) | Same flaw as risk: wave 1 runs t-1, t-2 and t-6 in parallel, gitleaks sits only in t-1, and the draft explicitly rejects adding the dependency. Signature changes (required LifecycleDeps field, required loadAdapterHandler arg) land with their consumers |

**Skeleton: risk.** It has the cleanest one-failure-mode-per-task boundaries, the sharpest contracts, and exactly one owner each for window, seam, notifier, driver, hooks, page and lifecycle. Its single wave defect (the gitleaks ordering) is fixed by making t-1 the only wave-1 task. From verification it takes the sealed-config store choice, the publish-inside-loadAdapterHandler contract, the AUMID failure handling, the click buffer, the e2e split with the real-class smoke, and the web no-card e2e. From mvp it takes the injected `watchExists` and the install helper living in desktop.ts.

## Merged plan

```
Phase 04-desktop-notify — 11 tasks across 6 waves

Wave 1
  t-1  Add notify bridge and phase gitleaks entry   [risk+verification]
       depends_on: —
       files:    .gitleaks.toml, src/lib/server/notify-bridge.ts, src/lib/server/notify-bridge.spec.ts
       desc:     ONLY wave-1 task; every other task depends on it (transitively), because vitest is red until the
                 gitleaks entry lands. .gitleaks.toml dross tests.json entry gains ^\.dross/phases/04-desktop-notify/tests\.json$.
                 notify-bridge.ts (no imports at all) declares DesktopNotice {title, body, clickPath(): Promise<string>},
                 DesktopNotifier {show(n): Promise<{ok:true}|{ok:false; reason:'unsupported'|'failed'}>}, publishNotifier(n),
                 readNotifier(): DesktopNotifier | undefined on globalThis[Symbol.for('price-check.notifier')].
       covers:   c-1
       contract: if the .gitleaks.toml tests.json allowlist lacks the exact anchored ^\.dross/phases/04-desktop-notify/tests\.json$ path, gitleaks-config.spec 'every phase allowlisted' fails (red on this branch today)
       contract: if a notifier published by one module instance is not returned by readNotifier from a second instance (vi.resetModules + re-import, as the main and server bundles are), notify-bridge.spec fails
       contract: if readNotifier() before any publish throws or returns anything but undefined (absence means "not in Electron", decision desktop_only_driver), notify-bridge.spec fails
       contract: if the notifier key is the same symbol as runtime-bridge's 'price-check.runtime' key (publishing one clobbers the other), notify-bridge.spec fails
       contract: if notify-bridge.ts gains any import statement (source read ?raw), notify-bridge.spec fails (it is bundled into main, which refuses $app/* and libsql)

Wave 2
  t-2  Add desktop kind, watch id, ensureChannel   [risk+verification]
       depends_on: t-1
       files:    src/lib/server/alerts/channel.ts, src/lib/server/alerts/channels.ts, src/lib/server/alerts/channels.spec.ts,
                 src/lib/server/alerts/alerts.ts, src/lib/server/alerts/alerts.spec.ts, src/lib/server/alerts/ntfy.spec.ts
       desc:     ChannelKind += 'desktop'. FailureReason += 'unsupported', label 'notifications not supported' (REASON_LABELS and
                 ntfy.spec's Record<FailureReason,string> labels table both gain it, or pnpm check goes red). Alert gains
                 optional watchId, set by alertAfterSuccess and alertAfterFailure. The click stays canonicalUrl. channels.ts gains
                 ensureChannel(db, key, kind, routing): insert-if-missing (onConflictDoNothing), enabled, sealed {} config.
                 It re-seals only a row whose config cannot be opened and keeps that row's flags. No migration (kind is a
                 plain-text PK with no CHECK).
       covers:   c-1, c-2, c-3, c-4, c-5
       contract: if describeFailure('unsupported') is not exactly 'notifications not supported', alerts.spec fails
       contract: if the Alert that alertAfterSuccess hands a registered fake driver lacks watchId === the watch's id, or its click is no longer the watch's canonicalUrl (ntfy/Resend/SMTP keep the shop click, decision click_target), alerts.spec fails
       contract: if alertAfterFailure's Alert lacks watchId === the watch's id, alerts.spec fails
       contract: if ensureChannel(db, key, 'desktop', {priceDrops:true, checkFailures:false}) on an empty table does not leave exactly one row {enabled:true, priceDrops:true, checkFailures:false} whose config_enc is non-null and opens to {}, channels.spec fails
       contract: if ensureChannel over an existing row the user set to {enabled:false, priceDrops:false, checkFailures:true} changes any of the three flags or updated_at, or a second call adds a row, channels.spec 'never overrides' fails (decision default_on_seed)
       contract: if a row sealed under another key stays undecryptable after ensureChannel (channelsFor would skip it forever with only a log line), or its flags change, channels.spec fails
       contract: if two concurrent ensureChannel calls (Promise.all) throw or leave other than one row, channels.spec fails

  t-3  Show window on a same-origin path   [risk+verification]
       depends_on: t-1
       files:    src/desktop/window.ts, src/desktop/window.spec.ts
       desc:     showWindow(state, path?) builds the URL with new URL(path, origin) and falls back to origin for one that
                 fails isAppUrl. createMainWindow takes the URL to load, so a new window loads the target as its first and
                 only loadURL. A live window is restored if minimised, loads the target, then shows and focuses. Without a
                 path, a live window is not reloaded.
       covers:   c-2
       contract: if showWindow(state, '/watches/w1') on a destroyed or never-created window creates a window whose loadURL calls are not exactly [origin + '/watches/w1'] (origin first = a double load), window.spec fails
       contract: if showWindow(state, '/watches/w1') on a minimised live window does not restore(), loadURL(origin + '/watches/w1') once, show() and focus(), or creates a second BrowserWindow, window.spec fails
       contract: if a path of '//evil.example/x', 'https://evil.example/' or '/\\evil.example' leads to loadURL with any non-app origin, window.spec's path table fails (each must load the origin)
       contract: if showWindow(state) with no path calls loadURL on an already-open window (tray Open or a second instance would lose the current page), window.spec fails

  t-4  Add e2e notification seam, unpackaged only   [risk]
       depends_on: t-1
       files:    src/desktop/notify-seam.ts, src/desktop/notify-seam.spec.ts
       desc:     notificationClassFor({isPackaged, env, Notification}) returns the real class unless the run is unpackaged
                 and PRICE_CHECK_E2E_NOTIFY is 'record' or 'unsupported'. It then returns a recording fake (structural
                 NotificationCtor: isSupported(), new({title, body}), on(event), show()) whose show() emits 'show'.
                 'unsupported' makes isSupported() false. Records live on globalThis[Symbol.for('price-check.e2e-notifications')]
                 as {shown: {title, body}[], click(index)}. click(index) emits 'click' on that instance only.
       covers:   c-1, c-2, c-5
       contract: if a packaged run (isPackaged true) with PRICE_CHECK_E2E_NOTIFY='record' or 'unsupported' gets anything but the real Notification class, notify-seam.spec fails
       contract: if an unpackaged run with the variable unset, empty or 'yes' gets anything but the real class, notify-seam.spec fails
       contract: if in 'record' mode a show() is not appended to shown with its exact title and body, or click(i) does not fire the 'click' listener of the i-th instance only, notify-seam.spec fails
       contract: if in 'unsupported' mode isSupported() is not false, notify-seam.spec fails
       contract: if click(i) for an index never shown throws in main instead of rejecting with a message naming the index, notify-seam.spec fails

  t-5  Add Electron notifier and APP_ID   [risk+verification]
       depends_on: t-1
       files:    src/desktop/notifier.ts, src/desktop/notifier.spec.ts, src/desktop/app-id.ts, src/desktop/app-id.spec.ts
       desc:     app-id.ts (no imports, so 05's electron-builder config can import it) exports APP_ID =
                 'io.github.rivil.price-check' and appUserModelIdFor({platform, isPackaged, execPath}): win32 packaged -> APP_ID,
                 win32 unpackaged -> execPath, else null. notifier.ts createNotifier({Notification, settleMs}) ->
                 {notifier, setClickHandler(fn), retainedCount()}, with Electron types via import type only. If isSupported()
                 is false: {ok:false,'unsupported'} with no construction. Otherwise it constructs and shows, resolving ok on
                 'show', {ok:false,'failed'} on 'failed', and ok at settleMs with neither. Each notification is retained until
                 click, close or failed, keeping the newest 20 at most. 'click' awaits clickPath() and calls the handler with
                 it, or with '/' if the call rejects or returns anything but a single-slash path. A click that arrives before
                 setClickHandler is buffered.
       covers:   c-1, c-2, c-5, c-6
       contract: if APP_ID !== 'io.github.rivil.price-check', or app-id.ts (source ?raw) contains any import, app-id.spec fails
       contract: if appUserModelIdFor is not APP_ID for win32 packaged, not the given execPath for win32 unpackaged, or not null for darwin/linux (packaged or not), app-id.spec's table fails
       contract: if a fake Notification with isSupported() false is constructed or shown, or show() resolves anything but {ok:false, reason:'unsupported'}, notifier.spec fails (c-5)
       contract: if a fake emitting 'show' does not resolve {ok:true}, or one emitting 'failed' first does not resolve {ok:false, reason:'failed'}, notifier.spec fails (decision delivery_result)
       contract: if a fake emitting neither event does not resolve {ok:true} at exactly settleMs (fake timers; not before), notifier.spec fails (unreported suppression = delivered)
       contract: if, after show() resolves on 'show', vi.getTimerCount() is not 0 (an armed settle timer would hold quit), notifier.spec fails
       contract: if retainedCount() is not 1 after show and 0 after 'click', 'close' or 'failed', or 25 unclicked notifications leave more than 20 retained, notifier.spec fails (a collected Notification loses its click listener; Linux may never emit close)
       contract: if 'click' does not call the handler exactly once with clickPath()'s resolved value ('/watches/w1'), a second 'click' on the same notification calls it again, or a rejecting clickPath / one resolving '//evil.example/x' or 'https://evil.example/' does not call it with '/', notifier.spec fails
       contract: if a click before setClickHandler throws or is lost (the handler set later must receive the path), notifier.spec fails
       contract: if the constructed notification's title/body differ from the notice's (truncated, re-encoded, markup-escaped), notifier.spec fails

Wave 3
  t-6  Add desktop driver and install helper   [risk+mvp+verification]
       depends_on: t-1, t-2
       files:    src/lib/server/alerts/desktop.ts, src/lib/server/alerts/desktop.spec.ts
       desc:     createDesktopDriver(notifier, {watchExists}): kind 'desktop', defaultKinds ['price_drop'], parseConfig -> ok({})
                 (ignores the form), view -> {}. send maps Alert to DesktopNotice (title and message verbatim). Its clickPath
                 resolves at click time: test alert -> '/account/alerts', a live watchId -> '/watches/' + encodeURIComponent(id),
                 a gone one -> '/'. Notifier 'unsupported' -> reason 'unsupported', 'failed' -> 'refused', a throw ->
                 'unreachable'; send never throws. installDesktop(db, key, notifier, {watchExists}) registers the driver,
                 calls ensureChannel(db, key, 'desktop', {priceDrops:true, checkFailures:false}) and returns the unregister.
                 desktop.spec drives alertAfterSuccess/alertAfterFailure over createTestDb() with a fake notifier and, where
                 named, a saved ntfy channel with a fake fetch (r-01).
       covers:   c-1, c-2, c-3, c-4, c-5
       contract: if, with installDesktop on an empty DB and no other channel, a check at 900 against a 1000 target does not end in exactly one show whose title contains the watch's title and whose body contains '£9.00' and '£10.00' (outcome 'sent', not 'no_channel'), desktop.spec fails (c-1)
       contract: if, with ntfy (fake fetch) also saved, the same drop does not reach both (fetch once, one show), desktop.spec fails (c-1 adjacency)
       contract: if, with ntfy and desktop routed and the notifier returning {ok:false,'failed'}, ntfy is not sent and recorded, or the next check re-sends ntfy or does not retry desktop, desktop.spec 'desktop failure isolated' fails
       contract: if a second alertAfterSuccess at 900 or 850 shows again (desktop outcome 'already_sent'), desktop.spec 'once per target' fails (c-3)
       contract: if price 1100 then 900 does not show a second time, or changing the target 1000 -> 950 with price 900 does not show on the next check, desktop.spec fails (c-3 re-arm)
       contract: if a show resolving {ok:false,'unsupported'} or {ok:false,'failed'} leaves a price_drop_delivery row for (watch,'desktop'), or the next check (notifier now ok) does not show, desktop.spec fails (delivery_result: retried)
       contract: if a show resolving ok does not record the delivery row, so the next at-target check shows again, desktop.spec fails (delivery_result: no flood)
       contract: if send returns anything but {ok:false, reason:'unsupported'} for an unsupported notifier or reason 'refused' for 'failed', or rejects when the notifier throws (must be 'unreachable'), desktop.spec fails
       contract: if clickPath() resolves anything but '/watches/a%2Fb%3Fc' for a live watch with id 'a/b?c', '/' once that watch is deleted, or '/account/alerts' for a 'test' alert, desktop.spec fails (c-2, click_target)
       contract: if a check_failed alert to desktop carries a clickPath that resolves to the shop URL instead of '/watches/<id>', desktop.spec fails
       contract: if alertAfterFailure with only the seeded desktop channel shows anything (failed checks off by default), or a desktop channel disabled via setEnabled still shows a drop, desktop.spec fails (c-4)
       contract: if installDesktop over a row the user set to {enabled:false, priceDrops:false, checkFailures:true} changes any flag, or a second installDesktop adds a row, desktop.spec 'seed never overwrites' fails
       contract: if, with no installDesktop, channelKinds() includes 'desktop' or saveChannel(..., 'desktop', ...) succeeds, or the unregister returned by installDesktop leaves 'desktop' in channelKinds(), desktop.spec fails (desktop_only_driver; no cross-spec leak)

  t-7  Publish notifier, set AUMID, route clicks   [risk+verification]
       depends_on: t-1, t-3, t-4, t-5
       files:    src/desktop/server.ts, src/desktop/server.spec.ts, src/desktop/testing/fake-handler.ts,
                 src/desktop/lifecycle.ts, src/desktop/lifecycle.spec.ts, src/desktop/main.ts
       desc:     loadAdapterHandler(env, url, appRoot, {notifier}) calls publishNotifier(notifier) along with env and chdir,
                 before the dynamic import. The argument is required (decision notify_bridge). LifecycleApp gains
                 setAppUserModelId. LifecycleDeps gains appUserModelId: string | null, notifications: {setClickHandler(fn)},
                 and showWindow(origin, path?). runDesktop sets the AUMID after the lock, before loadKey/startServer; a throw
                 is logged and skipped. It routes a click to showWindow(origin, path): held until ready (latest wins) and
                 dropped while quitting. main.ts builds the notifier from notificationClassFor({isPackaged, env,
                 Notification}) and createNotifier, passes it to loadAdapterHandler and its setClickHandler to runDesktop,
                 and passes appUserModelIdFor(...). main.ts stays the only electron value import. The executor also runs
                 pnpm check.
       covers:   c-1, c-2, c-6
       contract: if fake-handler.ts (which records readNotifier() !== undefined at top level) records false after loadAdapterHandler, server.spec 'notifier before import' fails (published after import -> hooks init sees none -> no driver)
       contract: if 'aumid' is recorded after 'loadKey' or 'startServer' in lifecycle.spec's call-order log, or setAppUserModelId is called more than once per startup, lifecycle.spec fails (c-6)
       contract: if appUserModelId null (darwin/linux) still calls app.setAppUserModelId, or a lost single-instance lock calls it, lifecycle.spec fails
       contract: if a throwing setAppUserModelId ends startup (no server, no tray) instead of being logged and skipped, lifecycle.spec fails
       contract: if a click delivered after startup does not call deps.showWindow(origin, '/watches/w1') exactly once, including on a tray-only login launch with no window yet, lifecycle.spec fails (c-2 closed window reopened)
       contract: if a click before startup is ready opens a window early or is lost, or two such clicks show other than the latest path once startup ends, lifecycle.spec fails
       contract: if a click after before-quit started calls deps.showWindow, lifecycle.spec fails
       contract: if any non-spec src/desktop file other than main.ts (notifier.ts, notify-seam.ts and app-id.ts included) value-imports 'electron', or src/lib/server/notify-bridge.ts imports electron or src/desktop, the existing boundary.spec fails; if the real main.ts entry fails to build, the existing build-desktop.spec 'real entry' fails

Wave 4
  t-8  Install desktop channel at server init   [risk+verification]
       depends_on: t-1, t-2, t-6
       files:    src/hooks.server.ts, src/hooks.server.spec.ts
       desc:     init: after migrateDb and before startScheduler, readNotifier(). If one is present, installDesktop(db,
                 alertsKey(), notifier, {watchExists: (id) => getWatch(db, id) !== null}). If none, do nothing.
                 Everything else in init stays as is.
       covers:   c-1, c-4
       contract: if init with a published fake notifier does not record order ['key','migrated','desktop','scheduler','published'], hooks.server.spec fails (the first scheduler pass must already route desktop)
       contract: if init with no notifier published calls installDesktop, registers 'desktop' in channelKinds() or writes a notify_channel row, hooks.server.spec 'no Electron, no desktop' fails (decision desktop_only_driver)
       contract: if the watchExists handed to installDesktop returns true for an id with no watch row, hooks.server.spec fails
       contract: if the registration made in one hooks.server.spec test is still in channelKinds() in the next (unregister not applied), hooks.server.spec fails

  t-9  Add Desktop card; refuse its removal   [risk+verification]
       depends_on: t-2, t-6
       files:    src/routes/account/alerts/+page.server.ts, src/routes/account/alerts/page.server.spec.ts,
                 src/routes/account/alerts/+page.svelte, src/routes/account/alerts/page.svelte.spec.ts,
                 src/routes/account/alerts/alerts.e2e.ts
       desc:     ?/remove kind=desktop -> fail(400, {kind, message:"The desktop channel can't be removed; disable it
                 instead."}) and the row is kept. ?/save, ?/enable, ?/disable and ?/test work for desktop through the
                 existing code (sealed {} config). The Svelte Desktop section (data-testid channel-desktop, first on the
                 page) renders only when data.channels has a 'desktop' key. It has on/off, Price drops and Failed checks
                 ticks, Save and Send test, no fields and no Remove. channelActions gains a removable flag. The web
                 alerts.e2e asserts there is no Desktop card under the node server.
       covers:   c-4, c-5
       contract: if load without the desktop driver registered returns any 'desktop' key, or after installDesktop (fake notifier, test DB) does not return channels.desktop = {enabled:true, priceDrops:true, checkFailures:false} with no unreadable flag, page.server.spec fails
       contract: if POST ?/remove kind=desktop returns anything but 400, or the desktop row or its price_drop_delivery rows are gone afterwards, page.server.spec fails; ?/remove kind=ntfy must still remove ntfy
       contract: if ?/save kind=desktop with only check_failures ticked does not leave {enabled:true, priceDrops:false, checkFailures:true}, or with neither ticked does not return NO_KINDS_MESSAGE and leave the row unchanged, page.server.spec fails
       contract: if after ?/disable kind=desktop channelsFor('price_drop') still routes desktop, page.server.spec fails (c-4 off stops sends)
       contract: if ?/test kind=desktop with a supported fake notifier does not return {tested:'desktop'} after exactly one show whose clickPath resolves '/account/alerts', or with an unsupported one does not return 502 testMessage exactly 'Not delivered: notifications not supported.', page.server.spec fails (c-5)
       contract: if ?/test kind=desktop on a disabled desktop channel does not show (a test goes out whatever the enabled state), page.server.spec fails
       contract: if data.channels without a 'desktop' key renders any channel-desktop section, page.svelte.spec fails
       contract: if data.channels.desktop = {enabled:true, priceDrops:true, checkFailures:false} does not render 'Status: Enabled', a checked 'Price drops' and an unchecked 'Failed checks' inside channel-desktop, page.svelte.spec fails (c-4 default)
       contract: if channel-desktop contains a Remove button or any text/password input, or the ntfy/Resend/SMTP cards lose their Remove, page.svelte.spec fails
       contract: if {testKind:'desktop', testMessage:'Not delivered: notifications not supported.'} renders outside channel-desktop, or {tested:'desktop'} does not render 'Test alert sent.' inside it, page.svelte.spec fails
       contract: if the desktop save form does not post kind=desktop with price_drops/check_failures checkbox names, page.svelte.spec fails
       contract: if /account/alerts under the node server (no Electron) shows a channel-desktop section, alerts.e2e fails (not vitest-gated; executor observes pnpm test:e2e green)

Wave 5
  t-10 Prove desktop delivery and click in Electron   [verification+risk]
       depends_on: t-7, t-8, t-9
       files:    e2e/desktop/launch.ts, e2e/desktop/harness.e2e.ts, e2e/desktop/notify.e2e.ts
       desc:     LaunchOptions/desktopEnv gain notify?: 'record' | 'unsupported', passed through as PRICE_CHECK_E2E_NOTIFY
                 (unset by default). launch.ts gains recordedNotifications(app) and clickNotification(app, i) via
                 electronApp.evaluate on the seam symbol. Alerts come from Send test and from 'Check now' on never-checked
                 watches seeded with https://shop.e2e.invalid/... URLs (failed check, no fetch, r-01; one fresh watch per
                 Check now because of the 15-min cooldown). Every OS takes the same path. The executor observes
                 pnpm test:e2e:desktop green locally before committing.
       covers:   c-1, c-2, c-4, c-5
       contract: if desktopEnv without a notify option contains PRICE_CHECK_E2E_NOTIFY, or with 'record' does not set it to 'record', harness.e2e 'launcher env' fails
       contract: if a fresh userData's /account/alerts in the app window does not show channel-desktop with 'Status: Enabled', Price drops checked, Failed checks unchecked and no Remove button, notify.e2e 'fresh install' fails (c-4 default; also fails if main published the notifier after the handler import)
       contract: if Send test on channel-desktop does not show 'Test alert sent.' and add exactly one record, notify.e2e fails (c-5)
       contract: if, with every window closed (BrowserWindow.close via evaluate), clicking that record does not leave exactly one visible window at <origin>/account/alerts, notify.e2e fails (c-2 closed window, test click target)
       contract: if, after ticking Failed checks and saving, 'Check now' on /watches/w0 (title 'E2E Kettle') does not add exactly one record whose title contains 'E2E Kettle', notify.e2e fails (server alert -> driver -> bridge -> main)
       contract: if, with the window on '/' and minimised, clicking that record does not leave the window visible, at <origin>/watches/w0 and (macOS/Windows, after asserting isMinimized() was true) not minimised, notify.e2e fails; on Linux the minimised precondition and claim are skipped (xvfb has no WM) and t-3 owns restore
       contract: if, after 'Check now' on w1 then deleting w1 through its page, clicking w1's record does not land on <origin>/ showing the watchlist, notify.e2e fails (c-2 deleted watch)
       contract: if a launch without the notify option has the recorder global defined (the real Notification class must be in use), notify.e2e fails

Wave 6
  t-11 Prove card settings, relaunch, unsupported, real class   [verification+risk]
       depends_on: t-10
       files:    e2e/desktop/desktop-alerts.e2e.ts
       desc:     Real Electron with the recorder. Card changes go through the window's forms. Alerts come from 'Check now'
                 on fresh unsupported-URL watches; checkNow awaits the hook, so the record count is final once the response
                 renders. One test uses the real Electron Notification class. The executor observes pnpm test:e2e:desktop
                 green locally before committing.
       covers:   c-4, c-5
       contract: if, with Failed checks unticked (Price drops left ticked), 'Check now' on a fresh watch adds any record, desktop-alerts.e2e fails (c-4 untick)
       contract: if, with the card disabled and Failed checks ticked, 'Check now' adds any record, desktop-alerts.e2e fails (c-4 off)
       contract: if, after Disable + Price drops unticked + Failed checks ticked, app.quit() and a relaunch on the same userData, the card does not show 'Status: Disabled' with those ticks, or dbSnapshot's desktop row has enabled true, desktop-alerts.e2e fails (c-4 survives relaunch; seed never re-enables)
       contract: if a launch with notify 'unsupported' shows anything but 'Not delivered: notifications not supported.' in channel-desktop after Send test, or adds a record, desktop-alerts.e2e fails (c-5)
       contract: if, with the real Notification class, Send test's card message disagrees with Notification.isSupported() read from main (false -> the unsupported message; true -> 'Test alert sent.' or 'Not delivered: refused.'), or reads 'Not delivered: unreachable.' (the driver caught a throw from the real Electron API), desktop-alerts.e2e fails on that OS
```

Coverage: c-1 t-1,2,4,5,6,7,8,10 · c-2 t-2,3,4,5,6,7,10 · c-3 t-2,6 · c-4 t-2,6,8,9,10,11 · c-5 t-2,4,5,6,9,10,11 · c-6 t-5,7. 6/6.

Wave check against the gate:
- t-1 is the only wave-1 task, so the gitleaks fix commits first.
- Within each wave, no two tasks share a file. W2: alerts/*, window.*, notify-seam.*, notifier.*+app-id.*. W3: alerts/desktop.*, plus server/lifecycle/main/fake-handler. W4: hooks.server.*, routes/account/alerts/*.
- Each union change lands with its consumers in t-2: ChannelKind and FailureReason with REASON_LABELS and the ntfy.spec table.
- Each required-signature change lands with its consumers in t-7: loadAdapterHandler with server.spec and main.ts, and LifecycleDeps with lifecycle.spec and main.ts.
- Each test that imports another task's module depends on that task. t-6 depends on t-2 for ensureChannel, t-8 and t-9 on t-6 for installDesktop, and t-7 on t-3, t-4 and t-5.

## E2E per-OS proof

All three OSes run the same `pnpm test:e2e:desktop` in the existing ci.yml matrix, against the real built main and server bundles.

Delivery is proven by swapping only the OS boundary. On unpackaged runs, `PRICE_CHECK_E2E_NOTIFY=record` replaces Electron's `Notification` class with the t-4 recorder. Everything else is the real code path: hooks install, the desktop driver, the cross-bundle bridge, main's notifier and settle logic, lifecycle routing and window.ts. The tests trigger alerts in two ways: Send test, and 'Check now' on an unsupported-URL watch with Failed checks ticked. A record whose title names the watch proves delivery.

Click is proven by `clickNotification(app, i)`, which emits `'click'` on that exact recorded instance. The test then asserts the real window's URL, its count and its minimised state.

| OS | Delivery | Click | Real-OS residue |
|---|---|---|---|
| macOS (macos-15) | Recorder record after Send test and Check now. t-11 real-class smoke: card message consistent with `isSupported()`, never 'unreachable' | Closed -> exactly one window at the target; minimised -> `isMinimized()` asserted true first, then false after the click, on /watches/w0; deleted -> / | The permission prompt and on-screen banner cannot be answered in CI. They count as delivered (delivery_result) and are proven in 05's signed packaged smoke (deferred) |
| Windows (windows-2025) | Same as macOS. The run is unpackaged, so the AUMID is execPath. t-7's lifecycle.spec proves setAppUserModelId(execPath) runs before startServer, and t-5 pins the packaged APP_ID | Same as macOS, minimise asserted | Toast routing under APP_ID needs 05's Start Menu shortcut (deferred). Action Center click after relaunch is deferred |
| Linux (ubuntu-24.04, `xvfb-run -a`) | Same recorder path, so no notification daemon is needed. The real-class smoke tolerates `isSupported()` either way: with no D-Bus session in INHERITED_ENV, a real show resolves via settle (ok) or 'failed' -> 'refused', never 'unreachable' | Closed and deleted asserted. Minimise is skipped: xvfb has no window manager, so `minimize()` may be a no-op and the claim would be vacuous. t-3's window.spec owns restore on every OS | Real libnotify display -> 05 AppImage smoke (deferred) |

## Disagreements

1. **Desktop row config_enc: null versus sealed `{}`.**
   - risk: config_enc null plus a `configless` driver flag. channelsFor, listChannels, saveChannel and loadChannelConfig treat it as `{}` and never decrypt it.
   - mvp: sealed `{}` through saveChannel, with no repair.
   - verification: sealed `{}` through a new `ensureChannel`, which re-seals an unreadable row and keeps its flags.
   - **Default:** sealed `{}` with re-seal (verification). It needs no carve-out in four store functions, and the re-seal closes risk's R3 (a key change silently muting desktop), which mvp's version leaves open.
   - **Why it matters:** with null, every config-reading path in channels.ts changes. Verified: `loadChannelConfig` returns null for a null row, so `?/test` would say "Save this channel first." unless risk's carve-out reaches it too. Sealed without re-seal leaves desktop silent after a key change, with only a log line.

2. **How the gitleaks fix commits first.**
   - risk and verification fold it into a t-1 that shares wave 1 with 3-4 independent tasks, and mark it "commit first" in prose. verification explicitly rejects adding the dependency as a "false data dependency".
   - mvp has a single wave-1 task, so it lands first by construction.
   - **Default:** t-1 is the only wave-1 task and everything depends on it. The gate dependency is real: no other task's vitest gate can go green before it lands.
   - **Why it matters:** with prose ordering, an executor that commits t-2 or t-3 first is blocked on a red gate it did not cause.

3. **Where APP_ID lives and where the AUMID is set.**
   - risk: app-id.ts. setAppUserModelId is a lifecycle dep called before whenReady.
   - verification: import-free app-id.ts. Called after the lock and whenReady, before loadKey; a throw is logged and skipped.
   - mvp: APP_ID exported from notifier.ts, set inside createDesktopNotifier. It rejects both app-id.ts and an ordering test ("before any notification" holds by construction).
   - **Default:** an import-free app-id.ts, set from lifecycle after the lock and before loadKey/startServer, with verification's throw handling.
   - **Why it matters:** 05's electron-builder config must import APP_ID without pulling in electron-typed modules. mvp's placement sets the AUMID at notifier creation, which main.ts runs at top level before the single-instance lock. A losing second instance would set it too, and nothing tests the order. The exact moment relative to whenReady is a minor open point: both lifecycle choices satisfy c-6.

4. **Where main publishes the notifier.**
   - risk: a LifecycleDeps.publishNotifier, called after whenReady and before startServer, ordered by lifecycle.spec's log.
   - mvp: main.ts top level, before runDesktop, with no test.
   - verification: a required `{notifier}` argument to loadAdapterHandler, published just before the dynamic import and proven by fake-handler recording `readNotifier()` at import.
   - **Default:** verification. It tests the exact hazard the locked notify_bridge decision names (publish before the handler import), not a proxy step in the lifecycle.
   - **Why it matters:** if the notifier is published late, hooks init sees none and desktop silently never registers. Only e2e would catch that under risk's and mvp's placements.

5. **How clicks reach the window.**
   - mvp: main.ts's openPath calls window.ts showWindow directly. lifecycle is untouched, so there is no quitting or pre-ready guard.
   - risk and verification route clicks through lifecycle's showWindow (dropped while quitting, held until ready). risk keeps the buffered path; verification makes the latest click win and adds a notifier-side buffer for clicks before setClickHandler.
   - **Default:** route through lifecycle, latest wins, notifier buffer included.
   - **Why it matters:** a click during quit would recreate a window under a shutting-down server. A click on a tray-only login launch before ready would be dropped.

6. **How a deleted watch is detected on click.**
   - All three resolve a closure (clickPath/open) server-side at click time. All reject a ServerRuntime method and any DB access from main.
   - risk: the driver takes `db` and queries it.
   - mvp and verification: an injected `watchExists` (getWatch) dependency.
   - **Default:** injected `watchExists`, wired in hooks (t-8 contract).
   - **Why it matters:** the injected form keeps desktop.ts free of a direct db dependency in its signature and makes the hooks wiring testable. Accepted residue (risk): a delete between resolve and load shows a 404.

7. **Copy for the 'unsupported' failure reason.** risk: 'not supported on this system'. mvp: 'unsupported'. verification: 'notifications not supported'.
   - **Default:** 'notifications not supported', so the card reads "Not delivered: notifications not supported."
   - **Why it matters:** it is pinned verbatim in t-2, t-9, t-11 and the svelte spec, so changing it later touches four tasks. mvp's bare 'unsupported' doesn't say what is unsupported.

8. **What triggers alerts in e2e.**
   - risk: scheduler 'unsupported-only' passes, aged last checks, then a powerMonitor 'resume'.
   - mvp and verification: 'Check now' on unsupported-URL watches.
   - **Default:** Check now. checkNow awaits the hooks, so record counts are final with no sleep.
   - **Why it matters:** a resume pass is asynchronous, so "no record" assertions there need a wait. Check now has a 15-min per-watch cooldown, so each Check now needs a fresh watch (stated in t-10/t-11).

9. **The e2e seam's default and env var.**
   - risk: default 'record' on every launch (no real toast in any e2e), var PRICE_CHECK_E2E_NOTIFY.
   - mvp: opt-in, var PRICE_CHECK_E2E_NOTIFICATIONS.
   - verification: opt-in, var PRICE_CHECK_NOTIFY_RECORD='1'.
   - **Default:** opt-in (mvp and verification), named PRICE_CHECK_E2E_NOTIFY with 'record'|'unsupported' (risk's name).
   - **Why it matters:** opt-in is what lets t-11 run the real Notification class and lets t-10 assert the recorder is absent by default. Risk's concern (stray real toasts) is low: existing specs trigger no alert, since failed checks are off by default and no e2e check can succeed.

10. **How the e2e work splits and whether real Notification runs.**
    - risk and mvp: one e2e task. risk lists a 'real' launch mode but gives it no contract. mvp rejects relying on real OS notifications.
    - verification: two tasks (delivery/click; settings, relaunch, unsupported) plus a per-OS real-class smoke that tolerates the outcome.
    - **Default:** the two tasks plus the smoke.
    - **Why it matters:** the recorder cannot catch broken real-constructor or event wiring in main ('unreachable'), and two failure surfaces behind one red are slower to diagnose.

11. **Linux minimise in e2e.**
    - risk skips the minimised case on Linux (no WM under xvfb) and leaves restore to t-3's unit test.
    - mvp and verification assert it on all OSes. Under xvfb that may pass vacuously.
    - **Default:** asserted on all OSes for URL and visibility. On macOS and Windows, `isMinimized()` is first asserted true as a precondition. On Linux the minimised precondition and claim are skipped.
    - **Why it matters:** an assertion that passes because `minimize()` did nothing proves nothing about restore.

12. **Granularity and task boundaries.**
    - mvp: 4 tasks. It merges bridge, types, driver and seed into one task, and notifier, window, seam and main into another, and explicitly rejects splitting either.
    - verification: 9 tasks. lifecycle and main are edited in two tasks, and hooks share a task with the page server.
    - risk: 10 tasks, one per failure mode.
    - **Default:** risk's boundaries with 11 tasks. The extra one is verification's e2e split. Hooks stay separate from the page, the seam stays separate from the notifier, and lifecycle and main are edited once (t-7).
    - **Why it matters:** with mvp's t-1, one red in any of five criteria blocks the whole server layer.

13. **Where the seam lives.** risk: src/desktop/notify-seam.ts, its own task. mvp: src/desktop/testing/recording-notification.ts. verification: src/desktop/e2e-notification.ts inside the notifier task.
    - **Default:** risk.
    - **Why it matters:** the seam ships in the main bundle, guarded by isPackaged, so a `testing/` path misstates that. A separate task keeps the "never active in a packaged build" contract owned by one spec.

14. **Notifier retention cap.**
    - risk caps retained notifications at the newest 20.
    - mvp and verification retain until click, close or failed, with no bound. They don't reject a cap; they don't consider one.
    - **Default:** the cap, grafted into t-5.
    - **Why it matters:** Linux daemons may never emit 'close', so without a cap every unclicked notification leaks for the life of the process.
