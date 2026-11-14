# 04-desktop-notify: MVP lens draft

```
Phase 04-desktop-notify: 4 tasks across 3 waves

Wave 1
  t-1  Add desktop channel driver and notifier bridge
       files:    .gitleaks.toml,
                 src/lib/server/notify-bridge.ts, src/lib/server/notify-bridge.spec.ts,
                 src/lib/server/alerts/channel.ts,
                 src/lib/server/alerts/desktop.ts, src/lib/server/alerts/desktop.spec.ts,
                 src/lib/server/alerts/alerts.ts, src/lib/server/alerts/alerts.spec.ts
       desc:     notify-bridge.ts (no $app, no electron) publishes/reads a DesktopNotifier on
                 globalThis[Symbol.for('price-check.notifier')]: show({title, body, open: () =>
                 Promise<string>}) -> Promise<'shown'|'failed'|'unsupported'>; readNotifier() returns
                 undefined when none is published. channel.ts: ChannelKind gains 'desktop', Alert
                 gains optional watchId, FailureReason gains 'unsupported' (label 'unsupported').
                 alerts.ts puts watchId: w.id on the price_drop and check_failed alerts (click stays
                 canonicalUrl). desktop.ts: createDesktopDriver({notifier, watchExists}) (kind
                 'desktop', defaultKinds ['price_drop'], parseConfig -> {}, view -> {}, send maps
                 shown->ok, failed->'refused', unsupported/no notifier->'unsupported', never throws;
                 open() -> /watches/<encoded id> if watchExists, else '/'; test alert -> '/account/alerts')
                 and installDesktopChannel(db, key, notifier, {watchExists}) which registers the driver
                 and, only when no 'desktop' row exists, writes one via saveChannel(…, {}, {priceDrops:
                 true, checkFailures: false}) so config_enc is a sealed '{}' (channelsFor's null-config
                 skip never hits it). .gitleaks.toml adds ^\.dross/phases/04-desktop-notify/tests\.json$
                 to the tests.json allowlist (gitleaks-config.spec is red on this branch today because
                 04's spec.toml exists without it, so this must land in the first commit).
       covers:   c-1, c-2, c-3, c-4, c-5
       contract:
         - if two module instances (vi.resetModules + re-import, as main and server bundles are) do not
           see the same published notifier, or readNotifier() before publish returns anything but
           undefined, notify-bridge.spec fails
         - if alertAfterSuccess over a test DB with the desktop driver (fake notifier) and a saved ntfy
           channel (fake fetch) sends to only one of them when price <= target, alerts.spec 'desktop
           and ntfy both alerted' fails (c-1 adjacency)
         - if the desktop notification's title lacks the watch title, or its body lacks the new price
           (e.g. '£12.34') and the target ('£15.00'), alerts.spec fails
         - if a second check still at or below target calls the fake notifier again, or a check above
           target followed by a drop does not call it again, or a target change followed by a check
           at/below the new target does not call it again, alerts.spec 'desktop once per target'
           fails (c-3)
         - if the desktop row is disabled, or price drops are unticked, and the fake notifier is still
           called on a drop; or check failures are unticked and alertAfterFailure still calls it,
           alerts.spec fails (c-4 routing)
         - if the ntfy send's alert.click is no longer the watch's canonicalUrl, alerts.spec fails
           (remote channels keep the shop-URL click)
         - if the fake notifier returns 'failed' and a price_drop_delivery row is still written for
           'desktop', or the next check does not re-send, alerts.spec fails (delivery_result retry)
         - if send() maps 'shown' to anything but {ok:true}, 'failed' to anything but reason 'refused',
           or 'unsupported' / no published notifier to anything but reason 'unsupported', or a
           notifier that throws makes send() reject, desktop.spec fails
         - if open() for a price_drop alert resolves anything but '/watches/<id>' while watchExists
           is true, or anything but '/' when it is false, or a test alert's open() is not
           '/account/alerts', desktop.spec fails (c-2 click target incl. deleted watch)
         - if installDesktopChannel on an empty test DB writes no row, or a row not {enabled: true,
           priceDrops: true, checkFailures: false} with non-null configEnc, desktop.spec fails (c-4)
         - if installDesktopChannel run twice over a row the user set to disabled / price drops off
           re-enables or re-ticks it, desktop.spec 'seed never overwrites' fails (c-4 survives relaunch)
         - if gitleaks-config.spec 'every phase allowlisted' fails for 04-desktop-notify, the
           .gitleaks.toml entry is missing
       depends:  —

Wave 2 (depends t-1)
  t-2  Register desktop channel and add Desktop card
       files:    src/hooks.server.ts, src/hooks.server.spec.ts,
                 src/routes/account/alerts/+page.server.ts, src/routes/account/alerts/page.server.spec.ts,
                 src/routes/account/alerts/+page.svelte, src/routes/account/alerts/page.svelte.spec.ts
       desc:     hooks init, after migrateDb and before startScheduler, calls installDesktopChannel
                 (watchExists via getWatch) only when readNotifier() returns a notifier; otherwise
                 nothing (desktop_only_driver). Alerts page: remove action refuses kind 'desktop'
                 (400, row kept); save/enable/disable/test work unchanged through the driver. Svelte:
                 a Desktop card rendered only when data.channels has a 'desktop' key, with on/off,
                 price-drops and failed-checks ticks, Save and Send test, no config fields, no Remove.
       covers:   c-4, c-5
       contract:
         - if init order is not ['key','migrated','desktop','scheduler','published'] when a notifier is
           published, hooks.server.spec fails (the first scheduler pass must see the desktop channel)
         - if init with no published notifier calls installDesktopChannel (or registers 'desktop' in
           channelKinds()), hooks.server.spec 'no Electron, no desktop' fails
         - if load, with the desktop driver installed over a test DB, does not return channels.desktop
           = {enabled: true, priceDrops: true, checkFailures: false}, page.server.spec fails
         - if load without the desktop driver registered returns any 'desktop' key, page.server.spec
           fails (no dead card in pnpm dev / browser e2e)
         - if the remove action for 'desktop' deletes the row instead of failing 400, page.server.spec
           fails
         - if save for 'desktop' with only check_failures ticked does not persist priceDrops false /
           checkFailures true, or disable does not persist enabled false, page.server.spec fails
         - if the test action with a fake notifier returning 'shown' does not return {tested:
           'desktop'}, or with 'unsupported' does not fail 502 with 'Not delivered: unsupported.',
           page.server.spec fails (c-5)
         - if the Desktop card renders a Remove button, a text input, or is missing its Send test
           button, page.svelte.spec fails; if data without channels.desktop still renders a Desktop
           heading, page.svelte.spec fails
       depends:  t-1

  t-3  Show native notifications and open clicked watch
       files:    src/desktop/notifier.ts, src/desktop/notifier.spec.ts,
                 src/desktop/window.ts, src/desktop/window.spec.ts,
                 src/desktop/testing/recording-notification.ts,
                 src/desktop/testing/recording-notification.spec.ts,
                 src/desktop/main.ts
       desc:     notifier.ts exports APP_ID = 'io.github.rivil.price-check' and
                 createDesktopNotifier({Notification, app, platform, execPath, openPath, settleMs}):
                 on win32 it calls app.setAppUserModelId(app.isPackaged ? APP_ID : execPath) during
                 creation; show() returns 'unsupported' without constructing when
                 Notification.isSupported() is false, else constructs, keeps a reference until
                 click/close, resolves 'failed' on the 'failed' event and 'shown' on 'show' or after
                 settleMs (unknown counts as delivered); 'click' awaits open() (rejection -> '/') then
                 openPath(path). window.ts: showWindow(state, path?) loads origin+path when path is an
                 app-relative '/…' path (new window or existing), leaves the page alone when path is
                 omitted. recording-notification.ts: selectNotification({isPackaged, env,
                 Notification}) returns a recording class only when unpackaged and
                 PRICE_CHECK_E2E_NOTIFICATIONS is 'record' or 'unsupported'; it records {title, body}
                 on globalThis[Symbol.for('price-check.e2e.notifications')] with click(i).
                 main.ts publishes the notifier (openPath -> showWindow(windowState, path)) before
                 runDesktop, i.e. before loadAdapterHandler imports the server.
       covers:   c-1, c-2, c-5, c-6
       contract:
         - if createDesktopNotifier on win32 packaged does not call setAppUserModelId('io.github.rivil.
           price-check') before it returns (spy order: setAppUserModelId precedes any constructor
           call), or on win32 unpackaged passes anything but execPath, or on darwin/linux calls it at
           all, notifier.spec fails (c-6)
         - if show() with isSupported() false constructs a Notification or resolves anything but
           'unsupported', notifier.spec fails (c-5)
         - if a fake Notification emitting 'failed' resolves 'shown', or one emitting neither event
           does not resolve 'shown' after settleMs (fake timers), notifier.spec fails (delivery_result)
         - if a 'click' on the fake does not call openPath with open()'s path, or a rejecting open()
           does not call openPath('/'), notifier.spec fails (c-2)
         - if the notifier drops its reference before 'click'/'close' (the held-set size is 0 after
           show resolves), notifier.spec fails (a GC'd notification loses its click handler)
         - if showWindow(state, '/watches/w1') with no window creates one that loads the bare origin
           instead of origin + '/watches/w1', or with a minimised window does not restore() and
           loadURL(origin + '/watches/w1'), window.spec fails (c-2 closed/minimised)
         - if showWindow(state) with no path calls loadURL on an existing window, or a path like
           '//evil.example' or 'https://x' is loaded instead of ignored, window.spec fails
         - if selectNotification returns the recording class when isPackaged is true (env set), or for
           an env value other than 'record'/'unsupported', recording-notification.spec fails (no test
           seam in shipped builds)
         - if the recording class in 'unsupported' mode reports isSupported() true, or click(i) does
           not emit 'click' on the i-th recorded instance, recording-notification.spec fails
         - if main.ts imports electron's Notification in any module but main.ts, or notifier.ts /
           recording-notification.ts import electron values, the existing boundary.spec 'main.ts is
           the only module that imports electron's values' fails
       depends:  t-1

Wave 3 (depends t-2, t-3)
  t-4  Prove desktop notify and click in Electron
       files:    e2e/desktop/launch.ts, e2e/desktop/notify.e2e.ts
       desc:     launch.ts: LaunchOptions/desktopEnv gain notifications?: 'record'|'unsupported' ->
                 PRICE_CHECK_E2E_NOTIFICATIONS, plus helpers recordedNotifications(app) and
                 clickNotification(app, i) via app.evaluate on the seam symbol. notify.e2e.ts runs the
                 real built app on all three CI OSes with the recording seam, so delivery and click are
                 proven identically on macOS, Windows and Linux/xvfb (the OS's own rendering and
                 isSupported() are unit-tested in notifier.spec and smoke-tested packaged in 05).
                 A real price drop needs a successful live check, which r-01 forbids, so the e2e
                 drives the same driver -> bridge -> notifier -> click path through Send test and a
                 'Check now' on a seeded unsupported-URL watch (a failed check, no fetch); the drop
                 itself is proven in alerts.spec. No workflow edit: playwright.desktop.config.ts
                 already matches e2e/desktop/**/*.e2e.ts, so ci.yml is untouched.
       covers:   c-1, c-2, c-4, c-5
       contract:
         - if a fresh launch's Alerts page shows no Desktop card, or it is not on with price drops
           ticked and failed checks unticked, notify.e2e 'desktop card defaults' fails (c-4)
         - if Send test does not show the sent message and record exactly one notification, or
           clicking it after the window is closed (BrowserWindow.getAllWindows()[0].close()) does not
           bring up a window on /account/alerts, notify.e2e 'send test and click' fails (c-5, c-2
           closed window)
         - if under notifications 'unsupported' Send test does not show 'Not delivered: unsupported.'
           on the Desktop card, notify.e2e fails (c-5)
         - if, with failed checks ticked, 'Check now' on seeded watch w0 (title 'E2E item',
           unsupported URL) records no notification naming 'E2E item', or clicking it with the window
           minimised does not restore it on /watches/w0, notify.e2e 'watch click' fails (c-2)
         - if, after w0 is deleted, clicking the same recorded notification lands anywhere but /,
           notify.e2e fails (c-2 deleted watch)
         - if, after turning Desktop off and unticking price drops, a relaunch on the same userData
           shows the card on or price drops ticked (dbSnapshot channels row too), notify.e2e
           'choice survives relaunch' fails (c-4)
       depends:  t-2, t-3
```

## Coverage

| Criterion | Tasks |
| --- | --- |
| c-1 native notification with item, price, target; remote channels still alerted | t-1 (driver, alerts.spec drop + adjacency), t-3 (Electron notifier), t-4 (end-to-end delivery in Electron) |
| c-2 click shows window on watch page; closed reopened, minimised restored; deleted -> watchlist | t-1 (open() path + deleted fallback), t-3 (click -> showWindow(path), restore/recreate), t-4 (e2e closed, minimised, deleted) |
| c-3 once per target; silent while at/below; re-arms on rise or target change | t-1 (alerts.spec 'desktop once per target' over the existing price_drop_delivery rows) |
| c-4 Desktop card default on / drops ticked / failures unticked; off or untick stops; survives relaunch | t-1 (seed defaults, never overwrites, routing), t-2 (card, save/disable, no Remove), t-4 (e2e defaults + relaunch) |
| c-5 Send test shows notification and reports sent; unsupported -> failure | t-1 ('unsupported' reason), t-2 (test action 200/502), t-3 (isSupported gate), t-4 (e2e both modes) |
| c-6 AUMID set to APP_ID on Windows before any notification | t-3 (set inside createDesktopNotifier, before any show is possible) |

All 6/6 criteria covered.

## Judgment calls

- No migration: notify_channel.kind is plain text with no CHECK, and the price_drop_delivery FK targets kind, so a 'desktop' row needs no schema change; rejected a db task.
- Seed through saveChannel with a sealed '{}' config, rejected teaching channelsFor/listChannels a null-config desktop row: zero changes to the routing store, and the existing per-channel delivery logic gives c-3 for free.
- c-3 gets no new code, only a desktop-specific alerts.spec contract; rejected a dedicated dedupe task because price_drop_delivery is already keyed (watch_id, kind) with target_pence.
- Deleted-watch fallback resolved server-side (driver's open() closure calls watchExists), rejected a ServerRuntime.watchPath method on runtime-bridge and rejected a route-level redirect; keeps main free of db access and the watch page's 404 unchanged.
- APP_ID lives in src/desktop/notifier.ts and the AUMID is set inside createDesktopNotifier, rejected a separate app-id.ts module and a lifecycle-ordering test: the notifier is the only way to show a notification, so "before any notification" holds by construction. 05 imports APP_ID from notifier.ts.
- Unpackaged win32 calls setAppUserModelId(execPath) explicitly, rather than leaving Electron's default; that is my reading of "Unpackaged runs use process.execPath".
- e2e proves delivery and click through an env-gated recording Notification class (unpackaged only), rejected relying on real OS notifications in CI (xvfb has no daemon, macOS needs permission) and rejected swapping the published notifier from app.evaluate (that would bypass notifier.ts and the click -> showWindow path).
- e2e uses Send test and a 'Check now' failure alert on an unsupported-URL watch, rejected adding a fake-shop seam to fake a successful drop: r-01 forbids live checks, and the drop path is fully unit-tested in alerts.spec.
- .gitleaks.toml goes in t-1 because gitleaks-config.spec already fails on this branch (04 has a spec.toml, no allowlist entry); no survivors.toml entry is needed, since survivors live in the already-allowlisted .dross/survivors.toml, not per phase.
- No ci.yml edit, so no supply-chain audit: playwright.desktop.config.ts already picks up e2e/desktop/notify.e2e.ts on all three OSes.
- No boundary.spec edit: its existing rules (electron values only in main.ts, src/lib never imports electron or src/desktop) already pin the notify_bridge decision.
- t-1 runs over the 5-file guideline (4 sources plus a one-line .gitleaks entry), rejected splitting bridge from driver: both are the same server-lib layer, and the split would add a wave in front of t-3.
- Hooks wiring and the Alerts page share t-2, rejected a separate hooks task: hooks is a one-call change and both are the server-side consumers of t-1.
