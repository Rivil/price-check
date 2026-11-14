# Risk-lens draft — 04-desktop-notify

Lens: each failure mode below is owned and tested by exactly one task.

| # | Failure mode | Owner |
|---|---|---|
| R1 | vitest is red before any work: `gitleaks-config.spec 'every phase allowlisted'` fails today because 04 has a spec.toml and no tests.json allowlist entry (observed 2026-11-14) | t-1 |
| R2 | Server and main bundles each hold their own module copy, so the notifier hand-off is never seen, or a missing notifier throws instead of meaning "not desktop" | t-1 |
| R3 | The desktop row has nothing to encrypt. `channelsFor` drops `config_enc IS NULL`, and a sealed `{}` turns unreadable after a key change, so desktop alerts stop with no error | t-2 |
| R4 | Startup seeding overwrites a user's off or untick on relaunch, or two seeds race | t-2 |
| R5 | Adding the watch id to Alert changes the click target for ntfy/Resend/SMTP | t-2 |
| R6 | A path from a notification click loads off-origin (`//evil`, `..`, an encoded `/`), or a new window loads `/` then the path (double load, flash, race) | t-3 |
| R7 | The e2e seam stays live in a packaged build, or real toasts fire during e2e and depend on xvfb `isSupported()` | t-4 |
| R8 | Electron Notification objects get garbage-collected before the click, so the click is lost. A notification that is never clicked leaks. A missing `show`/`failed` event hangs the send, or a pending timer holds quit | t-5 |
| R9 | Delivery result is misread: unsupported or `failed` counted as delivered, or unknown suppression counted as failed (re-notify flood) | t-5 (OS events → result), t-6 (result → SendResult/retry) |
| R10 | A deleted watch's click opens a 404. A `clickPath` rejection (DB closed while quitting) drops the click | t-6 (path), t-5 (rejection fallback) |
| R11 | Dedupe regresses for the desktop kind: repeat notifications at or below target, or no re-notify after a rise or target change. A failed desktop send blocks or re-sends other channels | t-6 |
| R12 | The driver is registered or seeded outside Electron (dead card, a failure log on every check), or the registration leaks across specs | t-7 |
| R13 | Desktop can be removed through a crafted `?/remove` (cascade-deletes delivery rows, then relaunch re-seeds it on and re-notifies). Send test reports "sent" when unsupported | t-8 |
| R14 | A click arriving during quit, before ready, or on a tray-only login launch creates a window wrongly or drops the path. AUMID set after the notifier exists. Notifier published after the handler import | t-9 |
| R15 | The whole path in real Electron on three OSes. Linux xvfb has no window manager, so `minimize()` may be a no-op | t-10 |

```
Phase 04-desktop-notify — 10 tasks across 4 waves

Wave 1
  t-1  Add notifier bridge and phase gitleaks entry
       files:    src/lib/server/notify-bridge.ts, src/lib/server/notify-bridge.spec.ts, .gitleaks.toml
       desc:     notify-bridge.ts (no $app, no electron) defines DesktopNotice {title, body, clickPath(): Promise<string>},
                 DesktopNotifier {show(n): Promise<{ok:true}|{ok:false; reason:'unsupported'|'failed'}>},
                 publishNotifier(n) and readNotifier(): DesktopNotifier | undefined on globalThis[Symbol.for('price-check.notifier')].
                 .gitleaks.toml dross tests.json entry gains ^\.dross/phases/04-desktop-notify/tests\.json$.
                 MUST be the first task committed: until it lands, every task's vitest gate is red (R1).
       covers:   c-1
       contract: if the .gitleaks.toml tests.json allowlist lacks the exact anchored ^\.dross/phases/04-desktop-notify/tests\.json$ path, gitleaks-config.spec 'every phase allowlisted' fails (it fails on main today)
       contract: if a notifier published by one module instance is not returned by readNotifier from a second instance (vi.resetModules + re-import, as main and server bundles are), notify-bridge.spec fails
       contract: if readNotifier before any publish throws or returns anything but undefined (absence means "not running in Electron", never an error), notify-bridge.spec fails
       contract: if the notifier key is the same symbol as runtime-bridge's 'price-check.runtime' key (publishing one clobbers the other), notify-bridge.spec fails

  t-2  Store configless desktop channel; carry watch id
       files:    src/lib/server/alerts/channel.ts, src/lib/server/alerts/channels.ts, src/lib/server/alerts/channels.spec.ts,
                 src/lib/server/alerts/alerts.ts, src/lib/server/alerts/alerts.spec.ts
       desc:     ChannelKind gains 'desktop'. ChannelDriver gains optional `configless: true`. FailureReason gains 'unsupported'
                 ('not supported on this system'). Alert gains optional watchId, set by alertAfterSuccess and alertAfterFailure.
                 channels.ts: a configless driver's row reads as config {} whatever config_enc holds (never decrypted, never
                 "unreadable", never skipped for null). saveChannel stores config_enc null for a configless kind.
                 seedDesktopChannel(db) inserts {kind:'desktop', enabled:true, price_drops:true, check_failures:false,
                 config_enc:null} ON CONFLICT DO NOTHING. No migration: kind is a plain-text PK with no CHECK.
       covers:   c-1, c-3, c-4
       contract: if channelsFor('price_drop') with a registered configless 'desktop' driver and a row whose config_enc is null skips that row (the existing "has no settings, skipped" branch), channels.spec fails
       contract: if a desktop row whose config_enc holds ciphertext sealed under another key is reported unreadable by listChannels, or skipped by channelsFor, channels.spec fails (a key change must not silently mute desktop)
       contract: if seedDesktopChannel on an empty table does not create exactly enabled=true, priceDrops=true, checkFailures=false, config_enc null, channels.spec fails
       contract: if seedDesktopChannel run after setEnabled(db,'desktop',false) and a save with priceDrops=false/checkFailures=true changes any of enabled, priceDrops or checkFailures, channels.spec 'seed never overrides' fails
       contract: if two concurrent seedDesktopChannel calls (Promise.all) throw or leave other than one desktop row, channels.spec fails
       contract: if saveChannel for the configless kind writes a non-null config_enc, or runs a non-configless driver's parseConfig against null, channels.spec fails
       contract: if the Alert that alertAfterSuccess hands a registered fake driver lacks watchId === the watch's id, or its click is no longer the watch's canonicalUrl (ntfy/Resend/SMTP keep the shop click), alerts.spec fails
       contract: if alertAfterFailure's Alert lacks watchId, alerts.spec fails
       contract: if describeFailure('unsupported') is not 'not supported on this system', channels.spec fails

  t-3  Show window on a same-origin path
       files:    src/desktop/window.ts, src/desktop/window.spec.ts
       desc:     showWindow(state, path?) builds the URL with new URL(path, origin) and refuses one that fails isAppUrl
                 (falls back to origin). A newly created window loads the target URL as its first and only loadURL. An existing
                 window is restored if minimised, loads the target, then shows and focuses. No path keeps today's behaviour
                 (no reload of a live window).
       covers:   c-2
       contract: if showWindow(state, '/watches/w1') on a destroyed window creates a window whose loadURL calls are not exactly ['http://127.0.0.1:<port>/watches/w1'] (origin loaded first = a double load), window.spec fails
       contract: if showWindow on a minimised window with a path does not restore() it and loadURL the path once, or creates a second BrowserWindow, window.spec fails
       contract: if a path of '//evil.example/x', 'https://evil.example/', or '/\\evil.example' leads to loadURL with any non-app origin, window.spec's path table fails (each must load the origin instead)
       contract: if showWindow(state) with no path calls loadURL on an already-open window (the user's page reset on tray Open), window.spec fails

  t-4  Add e2e notification seam, unpackaged only
       files:    src/desktop/notify-seam.ts, src/desktop/notify-seam.spec.ts
       desc:     notificationClassFor({isPackaged, env, Notification}) returns the real class unless unpackaged and
                 PRICE_CHECK_E2E_NOTIFY is 'record' or 'unsupported'. In those modes it returns a recording fake (structural
                 NotificationCtor declared here: isSupported(), new({title, body}), on(event), show()). show() emits 'show'.
                 'unsupported' makes isSupported() false. Records live on globalThis[Symbol.for('price-check.e2e-notifications')]
                 as {shown: {title, body}[], click(index)}, and click(index) emits 'click' on that instance.
       covers:   c-1, c-2, c-5
       contract: if a packaged run (isPackaged true) with PRICE_CHECK_E2E_NOTIFY='record' or 'unsupported' gets anything but the real Notification class, notify-seam.spec fails
       contract: if an unpackaged run with the variable unset, empty or 'yes' gets anything but the real class, notify-seam.spec fails
       contract: if in 'record' mode a show() is not appended to shown with its exact title and body, or click(i) does not fire the 'click' listener of the i-th instance only, notify-seam.spec fails
       contract: if in 'unsupported' mode isSupported() is not false, notify-seam.spec fails
       contract: if click(i) for an index never shown throws in main, notify-seam.spec fails (it must reject with a message naming the index)

Wave 2
  t-5  Add Electron notifier and APP_ID   (depends t-1)
       files:    src/desktop/notifier.ts, src/desktop/notifier.spec.ts, src/desktop/app-id.ts, src/desktop/app-id.spec.ts
       desc:     app-id.ts exports APP_ID = 'io.github.rivil.price-check' and appUserModelId({platform, isPackaged, execPath}):
                 win32 packaged -> APP_ID, win32 unpackaged -> execPath, otherwise null. notifier.ts createDesktopNotifier({Notification,
                 onClick, settleMs}) implements the bridge DesktopNotifier. isSupported() false -> {ok:false,'unsupported'} with no
                 construction. Otherwise construct, attach listeners, show(), resolve ok on 'show' or after settleMs with no event,
                 and resolve {ok:false,'failed'} on a 'failed' first. It retains each shown notification until 'click', 'close' or
                 'failed' (the GC guard), capped at the newest 20. On 'click' it awaits clickPath() and calls onClick(path), or
                 onClick('/') if clickPath rejects. Electron types via `import type` only.
       covers:   c-1, c-2, c-5, c-6
       contract: if APP_ID !== 'io.github.rivil.price-check', or appUserModelId returns other than APP_ID (win32 packaged), execPath (win32 unpackaged) or null (darwin, linux), app-id.spec fails
       contract: if a fake Notification with isSupported() false is constructed, or show() resolves other than {ok:false, reason:'unsupported'}, notifier.spec fails
       contract: if a fake that emits 'failed' before 'show' resolves {ok:true}, notifier.spec fails (delivery_result: a failed event is a send failure, retried)
       contract: if a fake that emits neither 'show' nor 'failed' leaves show() pending past settleMs (fake timers), or resolves anything but {ok:true}, notifier.spec fails (unreported suppression = delivered)
       contract: if, after show() resolves on 'show', vi.getTimerCount() is not 0 (a settle timer left armed would hold quit), notifier.spec fails
       contract: if a shown notification is no longer held by the notifier (retained().length) before 'click' or 'close', notifier.spec fails (the GC guard); if 25 unclicked notifications leave more than 20 held, notifier.spec fails
       contract: if a 'click' does not call onClick exactly once with clickPath()'s resolved value, or a rejecting clickPath does not call onClick('/'), or a second 'click' on the same notification calls onClick again, notifier.spec fails
       contract: if the constructed notification's title/body differ from the notice's (truncated, re-encoded), notifier.spec fails

  t-6  Add desktop channel driver with click paths   (depends t-1, t-2)
       files:    src/lib/server/alerts/desktop.ts, src/lib/server/alerts/desktop.spec.ts
       desc:     createDesktopDriver(notifier, db): kind 'desktop', configless, defaultKinds ['price_drop'], view {} and
                 parseConfig ok({}). send maps Alert -> DesktopNotice (title and message verbatim) with clickPath: a watchId
                 whose row still exists -> '/watches/' + encodeURIComponent(id), a gone watch -> '/', a test alert ->
                 '/account/alerts'. Notifier {ok:false,'unsupported'} -> reason 'unsupported', 'failed' -> 'refused', a throw ->
                 'unreachable'. It never throws. desktop.spec drives alertAfterSuccess/alertAfterFailure end to end over
                 test-db.ts with the real driver registered (registerDriver restore in afterEach) and a fake notifier.
       covers:   c-1, c-2, c-3, c-5
       contract: if, with only the seeded desktop row (no ntfy/Resend/SMTP saved), a check at £18.00 against a £20.00 target does not produce exactly one notice whose title names the item and whose body contains '£18.00' and '£20.00', desktop.spec fails (c-1)
       contract: if a second alertAfterSuccess at the same or a lower price notifies again, desktop.spec 'once per target' fails; if after a price above target (outcome 'rearmed') the next drop does not notify, or after the target changes from £20.00 to £19.00 with the price still under it the next check does not notify, desktop.spec fails (c-3)
       contract: if, with ntfy (fake fetch) and desktop both routed and the notifier returning {ok:false,'failed'}, ntfy is not sent and recorded, or the next check re-sends ntfy or does not retry desktop, desktop.spec 'desktop failure isolated' fails (c-1 adjacency)
       contract: if the notifier returning {ok:false,'unsupported'} makes send return other than {ok:false, reason:'unsupported'}, or a throwing notifier makes send reject, desktop.spec fails
       contract: if the notice's clickPath() for a live watch with id 'a/b?c' is not '/watches/a%2Fb%3Fc', for a watch deleted after the send is not '/', or for a test alert is not '/account/alerts', desktop.spec fails (c-2)
       contract: if a check_failed alert to desktop carries a clickPath that resolves to the shop URL instead of '/watches/<id>', desktop.spec fails

Wave 3
  t-7  Register desktop driver and seed at init   (depends t-1, t-2, t-6)
       files:    src/hooks.server.ts, src/hooks.server.spec.ts
       desc:     init: after migrateDb, readNotifier(). If present, registerDriver(createDesktopDriver(notifier, db)) then
                 await seedDesktopChannel(db). If absent, do neither. Everything else in init stays as is.
       covers:   c-1, c-4
       contract: if init with no published notifier registers 'desktop' (channelKinds() contains it) or writes a notify_channel row, hooks.server.spec fails (desktop_only_driver: no card, no send, no failure log outside Electron)
       contract: if init with a published fake notifier does not record order ['key','migrated','desktop','scheduler','published'], hooks.server.spec fails (the seed needs the tables, and the driver must exist before the scheduler's first pass)
       contract: if a second init over the same DB after the desktop row was disabled re-enables it, hooks.server.spec fails
       contract: if the registration made in one hooks.server.spec test is still in channelKinds() in the next (restore not applied), hooks.server.spec fails

  t-8  Add Desktop card to Alerts page   (depends t-2, t-6)
       files:    src/routes/account/alerts/+page.server.ts, src/routes/account/alerts/page.server.spec.ts,
                 src/routes/account/alerts/+page.svelte, src/routes/account/alerts/page.svelte.spec.ts
       desc:     Desktop card, shown only when channels.desktop is present (driver registered): On/Off, Price drops and
                 Failed checks ticks, Save, Send test. No fields and no Remove. ?/remove for kind 'desktop' -> 400 and nothing
                 deleted. ?/test for desktop goes through loadChannelConfig ({} for configless) and the driver, reporting
                 tested:'desktop' or 'Not delivered: not supported on this system.'.
       covers:   c-4, c-5
       contract: if load with the desktop driver unregistered returns a 'desktop' key in channels, or the page renders a Desktop heading, page.server.spec / page.svelte.spec fail
       contract: if load right after seedDesktopChannel does not return channels.desktop = {enabled:true, priceDrops:true, checkFailures:false} (no unreadable flag), page.server.spec fails (c-4 "starts on, price drops ticked, failed checks unticked")
       contract: if POST ?/remove with kind=desktop returns other than 400, or the desktop row or its price_drop_delivery rows are gone afterwards, page.server.spec fails (no Remove; a delete would re-arm every watch and the relaunch seed would re-enable it)
       contract: if POST ?/save kind=desktop with only check_failures ticked does not leave enabled=true, priceDrops=false, checkFailures=true, or with neither ticked does not return NO_KINDS_MESSAGE and leave the row unchanged, page.server.spec fails
       contract: if ?/disable kind=desktop then channelsFor('price_drop') still routes desktop, page.server.spec fails (c-4 "turning it off stops those notifications")
       contract: if ?/test kind=desktop with a fake notifier returning ok does not return {tested:'desktop'} and record one notice titled like the other channels' test, or with {ok:false,'unsupported'} does not return 502 'Not delivered: not supported on this system.', page.server.spec fails (c-5)
       contract: if the rendered Desktop card has a Remove button, any text/password input, or its ticks do not reflect the card's priceDrops/checkFailures, page.svelte.spec fails

  t-9  Wire notifier, AUMID and click into lifecycle   (depends t-1, t-3, t-4, t-5)
       files:    src/desktop/lifecycle.ts, src/desktop/lifecycle.spec.ts, src/desktop/main.ts
       desc:     LifecycleDeps gains setAppUserModelId(id) (called with appUserModelId(...) when non-null, before whenReady)
                 and publishNotifier(onClick) (after whenReady, before startServer). onClick(path) routes through the
                 lifecycle's showWindow, which now carries an optional path: ignored while quitting, buffered with the path
                 before ready. deps.showWindow(origin, path?) maps to window.ts showWindow(state, path). main.ts builds the
                 notifier from notificationClassFor({isPackaged, env, Notification}) and createDesktopNotifier, publishes it via
                 notify-bridge. It stays the only electron value import. Executor runs pnpm check (structural types meet here).
       covers:   c-2, c-6
       contract: if in the call-order log setAppUserModelId is not recorded before publishNotifier, or publishNotifier is not recorded before startServer (the handler import), lifecycle.spec fails
       contract: if setAppUserModelId is called on a darwin or linux deps set, lifecycle.spec fails
       contract: if onClick('/watches/w1') on a started tray-only login launch (no window yet) does not call deps.showWindow(origin, '/watches/w1') exactly once, lifecycle.spec fails (closed window is reopened on the watch)
       contract: if onClick after before-quit started calls deps.showWindow, lifecycle.spec fails
       contract: if onClick before the server is ready is dropped, or replayed without its path, once startup finishes, lifecycle.spec fails
       contract: if main.ts (or any non-spec src/desktop file other than main.ts) gains a value import of 'electron', or src/lib/server/notify-bridge.ts imports electron or src/desktop, the existing boundary.spec fails

Wave 4
  t-10 Prove notify, click and toggles in Electron   (depends t-7, t-8, t-9)
       files:    e2e/desktop/launch.ts, e2e/desktop/notify.e2e.ts
       desc:     launchDesktop gains notify: 'record' (default) | 'unsupported' | 'real', passed as PRICE_CHECK_E2E_NOTIFY
                 through desktopEnv, so no e2e run depends on an OS notification daemon (xvfb on Linux) and no real toast
                 pops on CI. Records are read and clicks triggered via electronApp.evaluate on the seam's symbol. Failure
                 alerts come from scheduler 'unsupported-only' passes over https://shop.e2e.invalid watches (r-01): tick
                 Failed checks on the Desktop card, age last checks, emit powerMonitor 'resume'. No CI workflow change:
                 test:e2e:desktop already collects e2e/desktop/*.e2e.ts on all three OSes. Executor observes
                 pnpm test:e2e:desktop green locally before committing.
       covers:   c-1, c-2, c-4, c-5
       contract: if a fresh userData's /account/alerts in the app window does not show a Desktop card that is on, with Price drops checked and Failed checks unchecked and no Remove button, notify.e2e 'fresh install' fails
       contract: if Send test on the Desktop card does not add one record and show the sent message, or clicking that record does not leave the window on /account/alerts, notify.e2e fails (c-5, test click target)
       contract: if a launch with notify: 'unsupported' shows anything but 'Not delivered: not supported on this system.' after Send test, notify.e2e fails (c-5)
       contract: if, after ticking Failed checks and a resume pass, there is no record whose title names watch w0's item, notify.e2e fails; if clicking it with the window closed (BrowserWindow.close) does not leave exactly one visible window whose URL path is /watches/w0, notify.e2e fails (c-2)
       contract: if, with the window minimised (skipped on linux: xvfb has no window manager, so t-3's unit test owns restore there), clicking a record does not leave isMinimized() false on /watches/w0, notify.e2e fails
       contract: if, after w0 is deleted through its page's Delete form, clicking its earlier record leaves the window anywhere but / (the watchlist), notify.e2e fails (c-2 empty edge)
       contract: if, after turning the Desktop card off and unticking Price drops, quit + relaunch on the same userData shows the card on or Price drops ticked, or a resume pass adds a record while off, notify.e2e 'choice survives relaunch' fails (c-4)
       contract: if desktopEnv passes PRICE_CHECK_E2E_NOTIFY other than the launch option (default 'record'), harness-style assertion in notify.e2e 'launcher env' fails (no real toast during e2e)
```

## Coverage

| Criterion | Tasks |
|---|---|
| c-1 native notice with no channel; other channels still alerted | t-1, t-2, t-4, t-5, t-6 (content + adjacency), t-7 (registration/seed), t-10 (real Electron, failure alert) |
| c-2 click → watch page; closed reopened, minimised restored, deleted → watchlist | t-3 (window), t-4, t-5 (click plumbing), t-6 (path + deleted), t-9 (lifecycle routing), t-10 |
| c-3 once per target; rearm on rise or target change | t-2 (watchId keyed delivery unchanged), t-6 (desktop-kind dedupe integration) |
| c-4 Desktop card defaults on; toggles stop sends; survives relaunch | t-2 (seed idempotency), t-7 (seed only in Electron, no re-enable), t-8 (card + toggles), t-10 (relaunch) |
| c-5 Send test reports sent / unsupported failure | t-4, t-5 (unsupported), t-6 (reason mapping), t-8 (page action), t-10 |
| c-6 AUMID before any notification on Windows | t-5 (APP_ID + id choice), t-9 (ordering) |

6/6 criteria covered.

## Judgment calls

- **Configless channel (config_enc null, never decrypted)**, not a sealed `{}` blob. With a sealed blob, a changed key makes desktop "unreadable", `channelsFor` then skips it with only a log line, and the seed never repairs an existing row. Desktop has nothing secret to seal.
- **`clickPath()` callback in the notice, resolved by the server-side driver over its db**, not a `watchExists` added to ServerRuntime and not an HTTP HEAD from main. It keeps the "is the watch gone" decision in the one bundle that owns the DB (boundary: no #lib/server/db in src/desktop) and leaves runtime-bridge untouched. The deleted-watch race (delete between resolve and load) is a 404 page, which I accept.
- **No migration.** notify_channel.kind is plain text with no CHECK. The seed has to run at startup and only under Electron (locked desktop_only_driver/default_on_seed), which a migration cannot tell apart.
- **New FailureReason 'unsupported'**, not reusing 'refused'/'unreachable'. The card must say the OS can't do it, not imply a network fault. Electron `failed` maps to 'refused'.
- **Settle window (resolve ok after settleMs with no event)**, not waiting indefinitely for 'show'. Linux daemons and Focus may never report, and delivery_result says unknown = delivered. A hung send would also block alertAfterSuccess's in-flight claim.
- **Notifier retains notifications (capped at 20)**, not fire-and-forget. Electron Notification objects are collectable once unreferenced, and a collected one never delivers 'click'. The cap bounds Linux, where 'close' may never fire.
- **Seam replaces only the Notification class (record/unsupported), unpackaged-only**, not a global "skip notifier" flag. The real notifier, the bridge, the driver and the click → lifecycle → window path all run in e2e. Only the OS boundary is faked, which is the part xvfb can't provide. Real OS display is 05's deferred packaged smoke test.
- **e2e proves delivery with check-failure alerts, not price drops.** A successful check needs a shop fetch (r-01 forbids live, and no e2e adapter fixture exists). Price-drop notice content and dedupe are owned by t-6's integration spec over the real driver and alertAfterSuccess.
- **Minimise case skipped on Linux e2e**, not forced. Without a window manager under xvfb, minimize() can be a no-op and the test would assert nothing. t-3's unit test owns restore on every OS.
- **No .github/workflows edit**, so no supply-chain audit is needed. test:e2e:desktop already globs e2e/desktop on three OSes. If the executor finds otherwise, that task must add the audit.
- **gitleaks entry folded into t-1 and ordered first**, not a standalone one-line task, and not left for a late wave. vitest is red on this branch until it lands (verified: gitleaks-config.spec fails now), so every other task's gate depends on it. survivors.toml is already allowlisted globally, so it needs no per-phase entry.
- **Server-side `?/remove` refusal for desktop**, not just hiding the button. A crafted POST would cascade-delete delivery rows and the next launch's seed would re-enable it, re-notifying every at-target watch.
- **Lifecycle + main.ts in one task (t-9)**: adding required LifecycleDeps would leave main.ts not compiling. pnpm check isn't in the vitest gate, but leaving the entry broken between commits is the Phase 02 trap.
- **Linux body markup not escaped**: rejected. Whether libnotify interprets `&`/`<` depends on the daemon's body-markup capability. Escaping would show `&amp;` on daemons without it. Titles go verbatim (t-5 contract pins no re-encoding).
