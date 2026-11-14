# 04-desktop-notify — verification-lens draft

Lens: each criterion's ideal test contract was written first; each task is the smallest change that makes those contracts satisfiable. Contracts are split by gate: vitest-gated ones (unit/integration over a real migrated test DB, fake notifier, injected fake Electron) carry the logic; the desktop e2e (real Electron, real built server, a recording Notification class swapped in only on unpackaged runs) proves the bundle-to-bundle path and the click on every OS, including Linux under xvfb.

Facts checked before planning:
- `pnpm vitest run scripts/gitleaks-config.spec.ts` is RED on this branch now: 'every phase allowlisted' fails for 04-desktop-notify (its spec.toml exists, its tests.json path is not in .gitleaks.toml). t-1 carries the fix and must be committed first.
- No migration is needed: `notify_channel.kind` is a plain text PK with no CHECK (drizzle/0009), and `price_drop_delivery.kind` references it, so a seeded 'desktop' row satisfies the FK.
- `channelsFor` skips `config_enc IS NULL` rows, so the seeded desktop row carries a sealed `{}` config and routes through the existing store unchanged.
- `checkNow` awaits `afterFailure`/`afterSuccess` (checks.ts:112-113), so once a "Check now" response renders, the alert has been sent. An e2e no-notification assertion is final at that point and needs no sleep.
- A watch with an unsupported URL (`https://shop.e2e.invalid/...`) fails its check with no fetch (r-01). That is the only real-pipeline alert the e2e can trigger. The e2e uses failed-check alerts for the watch-id click path, and a price drop is proven in vitest.
- No `.github/workflows/*.yml` edit: ci.yml already runs `pnpm test:e2e:desktop` (all of e2e/desktop/*.e2e.ts) on ubuntu/macos/windows, Linux under `xvfb-run -a`. New e2e files are picked up as they are.

```
Phase 04-desktop-notify — 9 tasks across 5 waves

Wave 1
  t-1  Add notify bridge, alert watch id, gitleaks entry
       files:    .gitleaks.toml, src/lib/server/notify-bridge.ts, src/lib/server/notify-bridge.spec.ts,
                 src/lib/server/alerts/channel.ts, src/lib/server/alerts/alerts.ts, src/lib/server/alerts/alerts.spec.ts
       desc:     COMMIT FIRST (vitest is red until the gitleaks entry lands). .gitleaks.toml dross tests.json entry gains
                 ^\.dross/phases/04-desktop-notify/tests\.json$ (survivors stay in the already-allowlisted global
                 .dross/survivors.toml; if dross writes a per-phase survivors.toml, its exact path joins that entry).
                 notify-bridge.ts (no imports) declares DesktopNotifier {isSupported(): boolean; show({title, body,
                 clickPath: () => Promise<string>}): Promise<{ok:true}|{ok:false; reason:'unsupported'|'failed'}>} and
                 publishNotifier/readNotifier on globalThis[Symbol.for('price-check.notifier')]; readNotifier returns
                 undefined when nothing is published. channel.ts: ChannelKind += 'desktop', FailureReason +=
                 'unsupported' (label 'notifications not supported'), Alert gains optional watchId. alerts.ts sets watchId
                 on the price-drop and failed-check alerts; click stays the shop URL.
       covers:   c-1, c-2, c-5
       contract: if any .dross/phases/<id>/ with a spec.toml (04 included) lacks its exact anchored tests.json path in
                 the single dross tests.json allowlist entry, gitleaks-config.spec 'every phase allowlisted' fails
                 (existing test, red today)
       contract: if two module instances (vi.resetModules + re-import, as the server and main bundles are) do not
                 read the same published notifier, notify-bridge.spec fails
       contract: if readNotifier() before any publish throws or returns anything but undefined (pnpm dev and browser
                 e2e have no notifier, decision desktop_only_driver), notify-bridge.spec fails
       contract: if notify-bridge.ts gains any import statement (its source read ?raw), notify-bridge.spec fails: it
                 is bundled into main, which refuses $app/* and libsql
       contract: if the Alert handed to a fake driver by alertAfterSuccess or alertAfterFailure lacks watchId === the
                 watch's id, or its click is no longer the watch's canonicalUrl (ntfy/Resend/SMTP keep the shop-URL click,
                 decision click_target), alerts.spec fails
       contract: if describeFailure('unsupported') is not exactly 'notifications not supported', alerts.spec fails

  t-2  Set Windows AppUserModelId before the server starts
       files:    src/desktop/app-id.ts, src/desktop/app-id.spec.ts, src/desktop/lifecycle.ts,
                 src/desktop/lifecycle.spec.ts, src/desktop/main.ts
       desc:     app-id.ts (no imports, so 05's electron-builder config can import it) exports APP_ID =
                 'io.github.rivil.price-check' and appUserModelIdFor({platform, isPackaged, execPath}): win32 packaged
                 -> APP_ID, win32 unpackaged -> execPath, else null. LifecycleApp gains setAppUserModelId; LifecycleDeps
                 gains appUserModelId: string | null. runDesktop calls app.setAppUserModelId(id) after the lock and
                 whenReady, before loadKey/startServer (the scheduler can notify as soon as the server is up). main.ts
                 passes appUserModelIdFor({platform: process.platform, isPackaged: app.isPackaged, execPath:
                 process.execPath}).
       covers:   c-6
       contract: if APP_ID !== 'io.github.rivil.price-check', or app-id.ts (source ?raw) contains any import,
                 app-id.spec fails
       contract: if appUserModelIdFor for win32 packaged is not APP_ID, for win32 unpackaged is not the given
                 execPath, or for darwin/linux (packaged or not) is not null, app-id.spec's table fails
       contract: if 'aumid' is recorded after 'startServer' (or after 'loadKey') in lifecycle.spec's call-order log,
                 or setAppUserModelId is called more than once per startup, lifecycle.spec fails
       contract: if appUserModelId null still calls app.setAppUserModelId, or a lost single-instance lock calls it,
                 lifecycle.spec fails
       contract: if a throwing setAppUserModelId ends startup (no server, no tray) instead of being logged and
                 skipped, lifecycle.spec fails

  t-6  Render the Desktop card without Remove
       files:    src/routes/account/alerts/+page.svelte, src/routes/account/alerts/page.svelte.spec.ts
       desc:     A 'Desktop' section (data-testid channel-desktop), first on the page, rendered only when
                 data.channels has a 'desktop' key. It shows the enabled state, an Enable/Disable form, a save form
                 (hidden kind=desktop, the two Send-me ticks, button 'Save'), and Send test. It has no Remove form.
                 channelActions gains a removable flag. Test/save messages render in the desktop card only.
       covers:   c-4, c-5
       contract: if data.channels without a 'desktop' key renders any channel-desktop section, page.svelte.spec fails
                 (decision desktop_only_driver)
       contract: if data.channels.desktop = {enabled:true, priceDrops:true, checkFailures:false} does not render
                 'Status: Enabled', a checked 'Price drops' and an unchecked 'Failed checks' checkbox inside
                 channel-desktop, page.svelte.spec fails (c-4 default)
       contract: if channel-desktop contains a Remove button, or the ntfy/Resend/SMTP cards lose theirs,
                 page.svelte.spec fails (decision default_on_seed)
       contract: if form {testKind:'desktop', testMessage:'Not delivered: notifications not supported.'} renders
                 outside channel-desktop, or {tested:'desktop'} does not render 'Test alert sent.' inside it,
                 page.svelte.spec fails
       contract: if the desktop save form does not post kind=desktop with price_drops/check_failures checkbox
                 names, page.svelte.spec fails

Wave 2 (depends t-1)
  t-3  Add desktop driver and startup channel seed
       files:    src/lib/server/alerts/desktop.ts, src/lib/server/alerts/desktop.spec.ts,
                 src/lib/server/alerts/channels.ts, src/lib/server/alerts/channels.spec.ts
       desc:     createDesktopDriver(notifier, {watchExists}): kind 'desktop', defaultKinds ['price_drop'],
                 parseConfig -> {} (ignores the form), view -> {}. send: unsupported -> {ok:false,
                 reason:'unsupported'}; show({title: alert.title, body: alert.message, clickPath}); a 'failed' result
                 -> reason 'refused'; a throw -> 'unreachable' (never throws). clickPath runs at click time: test alert
                 -> '/account/alerts'; watchId and the watch exists -> '/watches/<encoded id>'; else '/'.
                 channels.ts gains ensureChannel(db, key, kind, routing): insert-if-missing (onConflictDoNothing),
                 enabled, sealed {} config. It re-seals only a row whose config cannot be opened, keeping its flags.
                 installDesktop(db, key, notifier) registers the driver (returns the unregister) and ensures the row
                 with priceDrops true, checkFailures false. desktop.spec runs alertAfterSuccess/alertAfterFailure on a
                 createTestDb() DB with a fake notifier and, where named, a saved ntfy channel with a fake fetch (r-01).
       covers:   c-1, c-3, c-4, c-5
       contract: if, with installDesktop on an empty DB and no other channel, a check at 900 against a 1000 target
                 does not end in exactly one show whose title contains the watch's title and whose body contains
                 '£9.00' and '£10.00' (outcome 'sent', not 'no_channel'), desktop.spec fails (c-1)
       contract: if, with a saved ntfy channel too, the same drop does not reach both (fetch called once, one show),
                 or a desktop show that resolves unsupported stops ntfy recording its own delivery row, desktop.spec
                 fails (c-1 adjacency)
       contract: if a second alertAfterSuccess at 900 or at 850 calls show again (desktop outcome 'already_sent'),
                 desktop.spec fails (c-3)
       contract: if price 1100 then 900 does not show a second time, or changing the target 1000 -> 950 with price
                 900 does not show again on the next check, desktop.spec fails (c-3 re-arm)
       contract: if a show resolving {ok:false, reason:'unsupported'} or 'failed' leaves a price_drop_delivery row
                 for (watch, 'desktop'), or the next check (notifier now ok) does not show, desktop.spec fails
                 (decision delivery_result: retried)
       contract: if a show resolving ok (OS suppression it never reports) does not record the delivery row, so the
                 next at-target check shows again, desktop.spec fails (decision delivery_result: no flood)
       contract: if the payload's clickPath resolves anything but '/watches/<id>' for an existing watch, '/' once
                 that watch is deleted, or '/account/alerts' for a 'test' alert, desktop.spec fails (c-2, click_target)
       contract: if installDesktop on an empty DB does not leave exactly one 'desktop' row {enabled:true,
                 priceDrops:true, checkFailures:false} with a non-null config_enc, desktop.spec fails (c-4 default)
       contract: if installDesktop over an existing row {enabled:false, priceDrops:false, checkFailures:true}
                 changes any of the three flags or updated_at, or a second call adds a row, desktop.spec fails
                 (decision default_on_seed: never re-enables a user's off)
       contract: if a desktop row sealed under another key stays undecryptable after installDesktop (channelsFor
                 would skip it forever), or its flags change, channels.spec fails
       contract: if alertAfterFailure with only the seeded desktop channel shows anything (failed checks off by
                 default), or a desktop channel disabled via setEnabled still shows a drop, desktop.spec fails
       contract: if, with no installDesktop, channelKinds() includes 'desktop' or saveChannel(..., 'desktop', ...)
                 succeeds, desktop.spec fails (decision desktop_only_driver)
       contract: if send() rejects when the fake notifier's show throws, desktop.spec fails (drivers never throw)

  t-4  Add Electron notifier with e2e recorder
       files:    src/desktop/notifier.ts, src/desktop/notifier.spec.ts, src/desktop/e2e-notification.ts
       desc:     createNotifier({Notification}) -> {notifier: DesktopNotifier, setClickHandler(fn), retainedCount()}.
                 It takes Electron types via import type only. show() returns {ok:false,'unsupported'} when
                 Notification.isSupported() is false. Otherwise it constructs {title, body} and calls show(). It
                 resolves ok on 'show', {ok:false,'failed'} on 'failed', and ok after NOTIFY_SETTLE_MS with neither
                 event (decision delivery_result). Each instance is retained until 'click', 'close' or 'failed', so
                 GC cannot drop its click listener. 'click' awaits clickPath(), falls back to '/' on a rejection or
                 a value that is not a single-slash path, and calls the handler. e2e-notification.ts holds a
                 RecordingNotification class. It pushes {title, body, click()} to
                 globalThis[Symbol.for('price-check.e2e.notifications')] and emits 'show'. Its isSupported() is false
                 for mode 'unsupported'. notificationClassFor({env, isPackaged, Notification}) returns it only when
                 unpackaged and PRICE_CHECK_NOTIFY_RECORD is '1' or 'unsupported'.
       covers:   c-1, c-2, c-5
       contract: if a fake Notification emitting 'show' does not resolve {ok:true}, one emitting 'failed' does not
                 resolve {ok:false, reason:'failed'}, or one emitting neither does not resolve {ok:true} at exactly
                 NOTIFY_SETTLE_MS (fake timers; not before), notifier.spec fails
       contract: if isSupported() false constructs a Notification or calls show(), or resolves anything but
                 {ok:false, reason:'unsupported'}, notifier.spec fails (c-5)
       contract: if the constructor options' title/body differ from the payload's, notifier.spec fails
       contract: if retainedCount() is not 1 after show and 0 after 'click', 'close' or 'failed', notifier.spec
                 fails (an unreferenced Electron Notification loses its click listener)
       contract: if 'click' calls the handler with anything but the awaited clickPath() value
                 ('/watches/w1'), or a rejecting clickPath / one resolving '//evil.example/x' or
                 'https://evil.example/' does not call the handler with '/', notifier.spec fails
       contract: if a click before setClickHandler is called throws or is lost (the handler set later must still
                 receive the path), notifier.spec fails
       contract: if notificationClassFor returns RecordingNotification for a packaged run with
                 PRICE_CHECK_NOTIFY_RECORD='1', or for an unpackaged run without it, notifier.spec fails
       contract: if RecordingNotification in mode 'unsupported' reports isSupported() true, or its record.click()
                 does not reach the notifier's click path, notifier.spec fails

Wave 3 (depends t-3; t-7 also t-1, t-2, t-4)
  t-5  Install desktop channel at init; guard alerts actions
       files:    src/hooks.server.ts, src/hooks.server.spec.ts, src/routes/account/alerts/+page.server.ts,
                 src/routes/account/alerts/page.server.spec.ts, src/routes/account/alerts/alerts.e2e.ts
       desc:     init: after migrateDb and before startScheduler, readNotifier(). If present, installDesktop(db,
                 alertsKey(), notifier) with watchExists = getWatch(db, id) !== null. If absent, nothing. ?/remove with
                 kind=desktop -> fail(400, {kind, message:"The desktop channel can't be removed; disable it instead."})
                 with the row kept. ?/save, ?/enable, ?/disable and ?/test work for desktop through the existing code.
                 The web alerts.e2e asserts no Desktop card under the node server.
       covers:   c-4, c-5
       contract: if hooks init order is not ['key','migrated','desktop','scheduler','published'] with a notifier
                 published on Symbol.for('price-check.notifier'), hooks.server.spec fails (a first scheduler pass
                 must already route desktop)
       contract: if init with no notifier published calls installDesktop, hooks.server.spec fails
                 (desktop_only_driver)
       contract: if load with installDesktop (fake notifier, test DB) does not return channels.desktop =
                 {enabled:true, priceDrops:true, checkFailures:false}, or load without it returns any 'desktop' key,
                 page.server.spec fails
       contract: if ?/remove kind=desktop returns anything but 400, or the desktop row is gone afterwards,
                 page.server.spec fails; ?/remove kind=ntfy must still remove ntfy
       contract: if ?/save kind=desktop with only check_failures does not leave {priceDrops:false,
                 checkFailures:true} and enabled unchanged, or with neither ticked writes anything (NO_KINDS_MESSAGE),
                 page.server.spec fails
       contract: if ?/test kind=desktop with a supported fake notifier does not return {tested:'desktop'} after
                 exactly one show whose clickPath resolves '/account/alerts', or with an unsupported one does not
                 return 502 testMessage exactly 'Not delivered: notifications not supported.', page.server.spec fails
       contract: if ?/test kind=desktop on a disabled desktop channel does not show (a test goes out regardless
                 of the enabled state), page.server.spec fails
       contract: if /account/alerts under the node server (no Electron) shows a channel-desktop section,
                 alerts.e2e fails (not vitest-gated; the executor observes pnpm test:e2e green)

  t-7  Publish notifier before handler; route clicks
       files:    src/desktop/main.ts, src/desktop/server.ts, src/desktop/server.spec.ts,
                 src/desktop/testing/fake-handler.ts, src/desktop/lifecycle.ts, src/desktop/lifecycle.spec.ts,
                 src/desktop/window.ts, src/desktop/window.spec.ts
       desc:     loadAdapterHandler(env, url, appRoot, {notifier}) calls publishNotifier(notifier) with env and chdir
                 and before the dynamic import. The parameter is required, so main cannot forget it (decision
                 notify_bridge). LifecycleDeps gains notifications: {setClickHandler(fn)}, and
                 deps.showWindow(origin, path?). runDesktop routes a click to showWindow(origin, path): it is held
                 until ready (latest wins) and dropped while quitting. showWindow(state, path?) creates the window
                 straight on origin+path, or restores, shows, focuses and loadURLs origin+path on a live one. A path
                 failing isAppUrl falls back to origin. No path keeps the current page. main.ts builds the notifier from
                 notificationClassFor({env: process.env, isPackaged: app.isPackaged, Notification}) and passes it to
                 loadAdapterHandler and its setClickHandler to runDesktop. The executor runs pnpm check.
       covers:   c-1, c-2
       contract: if fake-handler.ts (which records readNotifier() !== undefined at top level) records false after
                 loadAdapterHandler, server.spec 'notifier before import' fails (published after import -> hooks
                 init sees none -> no driver)
       contract: if a click delivered after startup does not call deps.showWindow(origin, '/watches/w1') exactly
                 once, lifecycle.spec fails
       contract: if a click before running.ready opens a window early, is lost, or (two clicks) shows other than the
                 latest path once startup ends, lifecycle.spec fails
       contract: if a click after before-quit started shows or creates a window, lifecycle.spec fails
       contract: if showWindow(state, '/watches/w1') on a destroyed window does not create exactly one window whose
                 only loadURL is origin + '/watches/w1' (not origin, then the path), window.spec fails (c-2 closed)
       contract: if showWindow(state, '/watches/w1') on a minimised live window does not restore(), loadURL(origin +
                 '/watches/w1'), show() and focus(), or creates a second window, window.spec fails (c-2 minimised)
       contract: if a path of '//evil.example/x' or 'https://evil.example/' loads anything but the app origin,
                 window.spec fails
       contract: if showWindow(state) with no path calls loadURL on a live window (the tray's Open or a second
                 instance would lose the current page), window.spec fails
       contract: if any non-spec src/desktop file other than main.ts value-imports 'electron' (notifier.ts,
                 e2e-notification.ts included), boundary.spec fails (existing rule, now covering the new files); if
                 the real main.ts entry fails to build, build-desktop.spec 'real entry' fails (existing)

Wave 4 (depends t-5, t-6, t-7)
  t-8  Prove desktop delivery and click in Electron
       files:    e2e/desktop/launch.ts, e2e/desktop/harness.e2e.ts, e2e/desktop/notify.e2e.ts
       desc:     LaunchOptions gains notifications?: 'record' | 'unsupported'. desktopEnv then sets
                 PRICE_CHECK_NOTIFY_RECORD ('1' or 'unsupported'), and launch.ts gains recordedNotifications(app) and
                 clickNotification(app, index) via electronApp.evaluate on the recorder global. notify.e2e seeds
                 watches with unsupported URLs (https://shop.e2e.invalid/..., r-01) and works the real window. Every OS
                 takes the same path, Linux under xvfb included: only the Notification class is swapped, and the
                 driver, bridge, notifier, lifecycle and window are the real built ones. The executor observes pnpm
                 test:e2e:desktop green locally before committing.
       covers:   c-1, c-2, c-4, c-5
       contract: if desktopEnv without a notifications option contains PRICE_CHECK_NOTIFY_RECORD, or with 'record'
                 does not set it to '1', harness.e2e 'launcher env' fails
       contract: if a fresh userData's /account/alerts in the app window does not show channel-desktop with
                 'Status: Enabled', Price drops checked and Failed checks unchecked, notify.e2e fails (c-4 default; also
                 fails if main published the notifier after the handler import)
       contract: if Send test on channel-desktop does not show 'Test alert sent.' and add exactly one record,
                 notify.e2e fails (c-5)
       contract: if, with every window closed (BrowserWindow.close via evaluate), clicking that record does not
                 leave exactly one visible window at <origin>/account/alerts, notify.e2e fails
       contract: if, after ticking Failed checks and saving, 'Check now' on /watches/w0 (title 'E2E Kettle') does
                 not add exactly one record whose title contains 'E2E Kettle', notify.e2e fails (server alert ->
                 desktop driver -> bridge -> main, end to end)
       contract: if, with the window navigated to '/' and minimised, clicking that record does not leave the window
                 not minimised, visible and at <origin>/watches/w0, notify.e2e fails (c-2)
       contract: if, after 'Check now' on w1 then deleting w1 through its page, clicking w1's record does not land
                 on <origin>/ showing the watchlist, notify.e2e fails (c-2 deleted watch)
       contract: if a launch without the notifications option has the recorder global defined (the real
                 Notification class must be in use), notify.e2e fails

Wave 5 (depends t-8)
  t-9  Prove Desktop card settings, relaunch, unsupported
       files:    e2e/desktop/desktop-alerts.e2e.ts
       desc:     Real Electron with the recorder; card changes go through the window's forms, alerts are triggered
                 by 'Check now' on unsupported-URL watches (checkNow awaits the hook, so the record count is final
                 when the response renders). One test uses the real Electron Notification class. The executor observes
                 pnpm test:e2e:desktop green locally before committing.
       covers:   c-4, c-5
       contract: if, with Failed checks unticked (Price drops left ticked), 'Check now' on a fresh watch adds any
                 record, desktop-alerts.e2e fails (c-4 untick)
       contract: if, with the card disabled and Failed checks ticked, 'Check now' adds any record, desktop-alerts.e2e
                 fails (c-4 off)
       contract: if, after Disable + Price drops unticked + Failed checks ticked, app.quit() and a relaunch on the
                 same userData, the card does not show 'Status: Disabled' with those ticks (and dbSnapshot's desktop
                 row enabled false), desktop-alerts.e2e fails (c-4 survives relaunch; startup seeding never
                 re-enables)
       contract: if a launch with notifications 'unsupported' shows anything but 'Not delivered: notifications not
                 supported.' in channel-desktop after Send test, or adds a record, desktop-alerts.e2e fails (c-5)
       contract: if, with the real Notification class, Send test's card message disagrees with
                 Notification.isSupported() read from main (false -> the unsupported message; true -> 'Test alert
                 sent.' or 'Not delivered: refused.'), or reads 'Not delivered: unreachable.' (the driver caught a
                 throw from the real Electron API), desktop-alerts.e2e fails on that OS
```

## Coverage

| Criterion | Tasks | Where the decisive contract lives |
|---|---|---|
| c-1 native drop notification + other channels still alerted | t-1, t-3, t-4, t-7, t-8 | t-3 desktop.spec (price drop through alertAfterSuccess on a real DB, title/body money, ntfy alongside); t-8 notify.e2e (server alert reaches main's notifier in real Electron) |
| c-2 click shows window on the watch / restores / reopens / deleted -> watchlist | t-1, t-3, t-4, t-7, t-8 | t-3 clickPath resolution incl. deleted watch; t-4 click -> handler; t-7 lifecycle + window; t-8 closed / minimised / deleted in real Electron |
| c-3 once per target; silent at/below; re-arm on rise or target change | t-3 | t-3 desktop.spec on the existing per-channel price_drop_delivery rows, plus the delivery_result retry/no-flood split |
| c-4 Desktop card default on, ticks, off/untick stop, survives relaunch | t-3, t-5, t-6, t-8, t-9 | t-3 seed-never-overwrites; t-5 actions; t-6 render (no Remove); t-8 first-launch default; t-9 untick/off/relaunch |
| c-5 Send test sent / unsupported failure | t-1, t-3, t-4, t-5, t-6, t-8, t-9 | t-4 isSupported false; t-5 ?/test 502 copy; t-8 sent path; t-9 unsupported in Electron + real-class smoke per OS |
| c-6 Windows AUMID before any notification | t-2 | t-2 lifecycle order log ('aumid' before 'startServer') + app-id table (packaged APP_ID, unpackaged execPath) |

All 6 criteria covered. c-6's packaged-shortcut half is deferred to 05 by the spec; t-2 keeps app-id.ts import-free so 05's builder config can read APP_ID.

## Judgment calls

- Chose a recorder Notification class swapped in only on unpackaged runs with PRICE_CHECK_NOTIFY_RECORD. Rejected asserting real OS notifications: Linux xvfb has no daemon and Electron gives no delivery status on macOS/Linux. Rejected monkeypatching the published notifier from the test, because that would skip main's notifier code, which is the part under test.
- Chose failed-check alerts from 'Check now' on unsupported-URL watches as the e2e trigger. Rejected a test-only shop adapter or fixture server just to produce a price drop: that is new production surface near r-01. The drop path is proven in vitest on a real migrated DB, and it shares the driver, bridge and click path with what the e2e proves.
- Chose the driver to hand main a clickPath closure that resolves at click time. Rejected main querying the DB, which the boundary forbids, and rejected a new ServerRuntime.watchExists, which would widen runtime-bridge for one caller. A closure across bundles works in one process, and the deleted-watch rule stays a unit test with a real DB.
- Chose to seed the desktop row with a sealed `{}` config. Rejected a NULL config_enc plus a carve-out in channelsFor/listChannels. The existing store, routing and delivery rows then work unchanged, and the only new store code is insert-if-missing plus a re-seal of an unreadable row.
- Chose no migration. notify_channel.kind has no CHECK constraint, so adding 'desktop' is only a TS union change.
- Chose to make loadAdapterHandler take the notifier as a required argument and publish it before the import. Rejected a publish call in main.ts that only e2e would catch. The required argument makes the order a vitest contract, using the existing fake-handler top-level-recording pattern.
- Chose to put the AUMID call in lifecycle as an injected value with an order-log contract. Rejected a top-level call in main.ts that no unit test can reach.
- Chose to fold the gitleaks entry into t-1 and mark it commit-first. Rejected a standalone one-line task, which is too small, and rejected making every wave-1 task depend on it, which would be a false data dependency. vitest is red today, so whichever task commits first must carry it.
- Chose to put the Desktop card render (t-6) in wave 1. It depends only on the data shape load already produces generically, not on the driver.
- Chose to split the e2e into delivery/click (t-8) and settings/relaunch/unsupported (t-9), with t-9 after t-8 for the launch.ts option. Rejected one big e2e task, which would put two independent failure surfaces behind one red.
- Chose to edit no CI workflow. ci.yml already runs all e2e/desktop specs on three OSes, so no supply-chain audit is triggered.
- Chose a real-Notification smoke whose outcome is tolerant per OS. It cannot see the toast, but it catches a broken real constructor or event wiring ('unreachable') on each OS, which the recorder cannot.
