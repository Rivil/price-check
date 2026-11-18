# 03-desktop-shell: panel synthesis

Inputs: risk.md, mvp.md, verification.md, read against spec.toml, project.toml, rules.toml and the code on `phase/03-desktop-shell`.

Checked in the repo. These facts decide the scores below:

- vitest `server` project includes `src/**/*.spec.ts` and `scripts/**/*.spec.ts`, so `src/desktop/**` and `scripts/build-desktop.spec.ts` are picked up with no config edit. vitest pool is the default (`forks`), so `process.chdir` works inside a spec.
- tsconfig `include` is `src`, `scripts`, `vite.config.ts`, `playwright.config.ts`, `drizzle.config.ts`. `e2e/**` is only typechecked through what `playwright.config.ts` imports. A new `playwright.desktop.config.ts` is not typechecked unless it is added to `include`.
- `playwright.config.ts` has `testMatch: '**/*.e2e.{ts,js}'` and no testDir, so it would collect `e2e/desktop/*.e2e.ts` unless `testIgnore` excludes them. Its webServer runs `pnpm build && pnpm preview` against the shared seeded DB. The existing `e2e/harness.e2e.ts` relies on sorting first.
- **`src/lib/server/db/migrate.ts` resolves `drizzle/` from `process.cwd()`.** A packaged or Finder-launched Electron starts with cwd `/`, and risk's own e2e launches with cwd set to a temp dir. In both cases migrations are not found unless main `chdir`s to the app root before importing the handler. Only verification has this step (`chdir(appPath)` plus a contract). Risk and MVP would fail c-1 at runtime. This is grafted (into t-4).
- `startScheduler` returns a bare stop fn today. Its only consumer is `hooks.server.ts`, which ignores the return value. `tick()` returns `null` while a pass is running.
- adapter-node reads `PROTOCOL_HEADER` at module top level (`build/server/adapter-node-handler.js:483`), so env must be assigned before the handler import (risk t-4 contract).
- `esbuild` is in `onlyBuiltDependencies` but only a transitive dependency (0.28.2 via vite), so the esbuild route needs it as a direct devDependency. Electron is absent.
- `scripts/workflow-policy.spec.ts` tests the checker only on synthetic workflows. Only `pnpm ci:policy` in the static job checks the real `ci.yml`. Risk's "workflow-policy.spec's existing whole-repo check" does not exist.
- `.dross/phases/*` is tracked (01 and 02 carry tests.json), so a generic "every phase dir is allowlisted" gitleaks spec has real input on CI.

## Scores

Scale 1–5.

| Dimension | risk | mvp | verification |
|---|---|---|---|
| Criteria coverage | **4**: 9/9 at unit level, with black-box proof for c-1/2/3/4/5/6/7/9. c-8 and "checks keep running" are unit-only. Its e2e never adds a watch (c-3 names it), and without chdir its own first-run e2e cannot migrate. | **3**: 9/9 but thin. c-6/c-8 are unit-only, there is no DB close for c-9's Windows relaunch, no non-loopback-interface check for c-4, and no startup-failure path. | **5**: every criterion has a vitest contract and a real-Electron contract, including c-8 resume catch-up through the real scheduler (r-01-safe via unsupported-only watches). It is the only draft with chdir. |
| Test-contract specificity | **5**: the sharpest edge tables (corrupt and racing key, awkward userData path, env-before-import, X-Forwarded spoof, AppImage Exec, Windows unregister args, zombie on startup failure, resume mid-pass). One wrong claim: workflow-policy.spec does not scan the real ci.yml. | **3**: concrete but shallow. Eight lifecycle contracts are crammed into one spec, and there are no race or corrupt-input cases beyond the basics. | **5**: precise and black-box. CSRF variants (wrong scheme, `null`, no Origin), same-origin `?/add` with an unsupported URL → 400, a non-loopback TCP connect, `Not delivered` after relaunch (proves "send"), Electron Node major. |
| Granularity | **4**: 12 tasks of reasonable size. t-10 bundles the harness with two e2e files. | **2**: t-4 is window + tray + lifecycle + links (8 contracts, one spec). t-6 is all e2e + CI + gitleaks. | **4**: 13 tasks. t-1 mixes the build scaffold with an unrelated gitleaks change. |
| Wave correctness (green per commit) | **4**: interface changes ship with their consumers (t-2 hooks). Two holes: t-9's boundary.spec bans `#lib/server/db/*` in "any src/desktop file", which t-3's own server-env.spec ('awkward path') imports, so it is red unless scoped to non-spec files. t-8 (wave 2, parallel with t-5..t-7) has no stated rule against type-importing the sibling modules, so `pnpm check` is red if it lands first. | **4**: green-safe because the wave-1 modules use structural interfaces and t-5 carries dep + entry together. The runtime gaps (no chdir, desktop e2e in the default config) are outside the commit gate. | **4**: green-safe because the electron dep lands first and local structural interfaces are used. Smells: t-1 adds a not-yet-existing file to tsconfig `include` (harmless to tsc, but out of place), t-9's playwright-config assertions are hosted in `scheduler.spec.ts`, and the tsc route compiles the transitive `src/lib` files whose `#lib` imports t-1's scan does not cover. |

**Skeleton: risk.** It has the best failure-mode coverage per task, its wave layout already pairs the scheduler interface change with its hooks consumer, and its esbuild route (shared with MVP) removes the `#lib`/`.ts` specifier hazard that verification's tsc route has to police by scan. From verification it takes the chdir step, the richer CSRF/Host and relaunch-send e2e, the c-5/c-8 scheduler-enabled e2e, the Node-major check, the vitest-gated playwright config split and a dedicated `ci-desktop.spec.ts`. From MVP it takes the structural-interface discipline for parallel wave-2 modules, the parseAlertsKey round-trip and the `setEnabled(true)` re-create contracts.

## Merged plan

```
Phase 03-desktop-shell — 14 tasks across 5 waves

Wave 1
  t-1  Add Electron toolchain and desktop bundle build        [risk+mvp+verification]
       wave:       1
       depends_on: —
       files:      package.json, pnpm-lock.yaml, pnpm-workspace.yaml, .gitignore,
                   scripts/build-desktop.ts, scripts/build-desktop.spec.ts
       desc:       electron (exact pin: newest stable whose bundled Node major equals .node-version's
                   24) and esbuild (exact pin) as direct devDependencies; onlyBuiltDependencies
                   [electron, esbuild]. scripts/build-desktop.ts (script build:desktop) bundles an entry
                   (default src/desktop/main.ts) to dist-desktop/main.js: ESM, platform node, electron
                   external, #lib/* inlined; rejects $app/*, @libsql/*, drizzle-orm/libsql imports.
                   package.json main = dist-desktop/main.js; /dist-desktop gitignored. Spec fixtures go
                   through esbuild stdin with resolveDir = repo root, so no fixture file needs to typecheck.
       covers:     c-1
       contract:   if pnpm-workspace.yaml onlyBuiltDependencies is not exactly ['electron','esbuild'] (a
                   wildcard, a missing electron, or any extra package), build-desktop.spec fails
       contract:   if electron's postinstall was denied, the path the 'electron' package exports does not
                   exist and build-desktop.spec 'electron binary installed' fails
       contract:   if electron or esbuild in package.json carries ^, ~, a range or a tag instead of an
                   exact x.y.z, build-desktop.spec fails
       contract:   if a fixture entry importing 'electron' and '#lib/server/local-request.ts' builds to an
                   output that inlines electron, or still contains a '#lib/' specifier (Electron cannot
                   resolve it to .ts), build-desktop.spec fails
       contract:   if a fixture entry importing '$app/env', '@libsql/client' or 'drizzle-orm/libsql' builds
                   instead of failing with an error naming the import, build-desktop.spec fails
       contract:   if package.json main !== the build's outfile ('dist-desktop/main.js'), the default entry
                   is not src/desktop/main.ts, or the output contains the repo's absolute path,
                   build-desktop.spec fails
       contract:   if .gitignore does not ignore /dist-desktop (prettier and eslint would then scan the
                   bundle), build-desktop.spec fails

  t-2  Expose scheduler and DB controls to main               [risk+verification+mvp]
       wave:       1
       depends_on: —
       files:      src/lib/server/scheduler.ts, src/lib/server/scheduler.spec.ts,
                   src/lib/server/runtime-bridge.ts, src/lib/server/runtime-bridge.spec.ts,
                   src/hooks.server.ts, src/hooks.server.spec.ts
       desc:       Scheduler gains requestPass() (runs now if idle, else queues exactly one follow-up pass)
                   and async stop(drainMs) (clears the interval, awaits the in-flight pass up to drainMs).
                   startScheduler returns {requestPass, stop} | null; its one consumer, hooks.server.ts,
                   changes in this task. runtime-bridge.ts (no $app imports) publishes/reads
                   globalThis[Symbol.for('price-check.runtime')]. hooks init publishes {requestPass, stop,
                   closeDb}, with no-op controls when the scheduler is null and closeDb = db.$client.close
                   (idempotent).
       covers:     c-8, c-9
       contract:   if requestPass() during a running pass is dropped (tick()'s overlap guard returns null),
                   scheduler.spec 'resume mid-pass' fails: after the running pass resolves exactly one more
                   pass must run, and its due(now) must receive the post-resume clock
       contract:   if a fake clock jumps 8h (sleep) and the resume pass's due() is called with the
                   pre-sleep time, or a watch that came due during the jump is not checked,
                   scheduler.spec 'due during sleep' fails
       contract:   if, with three watches last checked at t0 and now() jumped to t0 + 3 intervals, one
                   requestPass() over a migrated test DB does not call checkOne for all three in one pass,
                   scheduler.spec 'catch-up after sleep' fails
       contract:   if two requestPass() calls during one pass yield two follow-up passes (pile-up), or a
                   requestPass() while idle does not start a pass synchronously, scheduler.spec fails
       contract:   if stop() resolves while a checkOne is still pending (deferred promise unresolved) and
                   drainMs has not elapsed, scheduler.spec fails (quit would close the db under a pass)
       contract:   if stop() leaves the interval armed (fake timers advanced 3 × TICK_MS after stop call
                   due() again), or a pass that never settles makes stop() hang past drainMs,
                   scheduler.spec 'stop drains' fails
       contract:   if startScheduler with SCHEDULER_DISABLED='1', VITEST set or building does not return
                   null, scheduler.spec fails (r-01: no live check from any test run)
       contract:   if two module instances (vi.resetModules + re-import, as the server bundle and the main
                   bundle are) do not see the same published runtime, or reading before publish does
                   anything but throw 'server runtime not published', runtime-bridge.spec fails
       contract:   if closeDb() closes the client twice when called twice, runtime-bridge.spec fails
       contract:   if hooks init order is not ['key','migrated','scheduler','published'], the published
                   controls are not the startScheduler result's, closeDb does not call the db's
                   $client.close, or a disabled scheduler (startScheduler -> null) publishes no controls
                   or controls whose requestPass throws or whose stop() rejects, hooks.server.spec fails

  t-3  Bootstrap first launch: paths, key, env               [risk+mvp+verification]
       wave:       1
       depends_on: —
       files:      src/desktop/app-paths.ts, src/desktop/app-paths.spec.ts,
                   src/desktop/alerts-key.ts, src/desktop/alerts-key.spec.ts,
                   src/desktop/server-env.ts, src/desktop/server-env.spec.ts
       desc:       resolveUserDataDir({appData, isPackaged, env}) -> <appData>/price-check, overridable by
                   PRICE_CHECK_USER_DATA only when unpackaged; desktopPaths -> dbFile, keyFile.
                   loadOrCreateAlertsKey(keyFile): mkdir -p, create via temp file + exclusive link (mode
                   0600), never rewrite an existing key, refuse a bad one. serverEnv(inherited, {dbFile,
                   key}) builds the env the adapter handler is imported under. No module here imports
                   #lib/server/db/* (only specs may).
       covers:     c-1, c-2
       contract:   if a second loadOrCreateAlertsKey on the same file returns different bytes, or the file's
                   sha256 changes, alerts-key.spec 'never regenerated' fails; a value sealed with
                   encryptSecret under launch 1's key must decryptSecret under launch 2's key (c-2)
       contract:   if the key written on an empty dir is not accepted by parseAlertsKey, alerts-key.spec
                   fails
       contract:   if an existing key file that is empty, truncated, non-base64 or 31/33 bytes decoded is
                   replaced instead of throwing an error that names the file path (and the file stays
                   byte-identical), alerts-key.spec 'bad key refused' fails
       contract:   if two concurrent first-launch calls (Promise.all) return different keys, or a key
                   created between the existence check and the write is overwritten, alerts-key.spec fails
       contract:   if a leftover 'alerts.key.tmp-*' from an interrupted write is read as the key or blocks
                   creation, alerts-key.spec fails
       contract:   on POSIX (skipIf win32), if the created file's mode & 0o777 !== 0o600, alerts-key.spec
                   fails; if any thrown message contains the key's base64 or the file's contents,
                   alerts-key.spec fails
       contract:   if a missing nested userData dir makes first launch throw, alerts-key.spec fails
       contract:   if packaged resolveUserDataDir honours PRICE_CHECK_USER_DATA, or the dir name is not
                   exactly 'price-check' under appData, app-paths.spec fails
       contract:   if inherited ORIGIN, HOST_HEADER, PORT_HEADER, ADDRESS_HEADER survive serverEnv, or an
                   inherited PROTOCOL_HEADER/DATABASE_URL/ALERTS_ENCRYPTION_KEY wins over the desktop's own
                   values (PROTOCOL_HEADER must be 'x-forwarded-proto'), server-env.spec fails
       contract:   if SCHEDULER_DISABLED or CHECK_INTERVAL_HOURS are not passed through, server-env.spec
                   fails
       contract:   if DATABASE_URL for a userData dir named 'Application Support Zoë #1 50%' does not let
                   createDb + migrateDb create exactly <dir>/price-check.db (existsSync true, no stray file
                   in cwd), server-env.spec 'awkward path' fails

  t-4  Add loopback http wrapper and handler loader            [risk+verification+mvp]
       wave:       1
       depends_on: —
       files:      src/desktop/server.ts, src/desktop/server.spec.ts,
                   src/desktop/testing/fake-handler.ts
       desc:       startDesktopServer({handler}) listens on 127.0.0.1 port 0. For every request, Host is
                   checked first with isLoopbackHost (403 text, handler never called), client
                   X-Forwarded-Proto/X-Forwarded-Host are removed, X-Forwarded-Proto is set to 'http', then
                   handler(req,res). close() ends keep-alive sockets. loadAdapterHandler(env, moduleUrl,
                   appRoot) assigns env to process.env and chdir(appRoot) (migrate.ts resolves drizzle/
                   from cwd) BEFORE the dynamic import. The spec restores cwd after each test.
       covers:     c-1, c-3, c-4, c-9
       contract:   if server.address() is not {address:'127.0.0.1', family IPv4, port>0}, or two starts
                   share a port, server.spec fails; if a non-internal IPv4 interface exists, connecting to
                   it at that port must be refused (skip when none)
       contract:   if a request with Host 'evil.example' to '/_app/immutable/chunks/x.js', '/health' or '/'
                   reaches the handler, or gets anything but 403, server.spec's host table fails; a raw
                   request with no Host (setHost: false) must also 403 without reaching the handler; Host
                   '127.0.0.1:<port>' and 'localhost:<port>' pass
       contract:   if a client-sent 'X-Forwarded-Proto: https' (or 'https, http') reaches the handler as
                   anything but exactly one 'http' value, or X-Forwarded-Host survives, server.spec fails
                   (adapter-node would build an https origin and Kit's CSRF check would 403 every POST)
       contract:   if close() with an idle keep-alive connection open takes over 1s, or the port still
                   accepts a connection after close() resolves, server.spec 'close with keep-alive' fails
       contract:   if loadAdapterHandler imports the fixture module (src/desktop/testing/fake-handler.ts,
                   which records process.env.PROTOCOL_HEADER and process.cwd() at top level) before
                   assigning env and chdir-ing, the recorded PROTOCOL_HEADER is not 'x-forwarded-proto' or
                   the recorded cwd is not appRoot, and server.spec 'env and cwd before import' fails

Wave 2 (depends t-1; t-8 also t-2)
  t-5  Add main window with external-link policy             [risk+verification+mvp]
       wave:       2
       depends_on: t-1
       files:      src/desktop/window.ts, src/desktop/window.spec.ts
       desc:       createMainWindow(deps, origin): contextIsolation true, nodeIntegration false, sandbox
                   true, no preload. setWindowOpenHandler always denies (http/https off-origin ->
                   shell.openExternal; same-origin -> load in this window). Off-origin will-navigate and
                   will-redirect are prevented. Close destroys the window and never preventDefaults.
                   showWindow(state) recreates a destroyed/never-created window, restores a minimised one,
                   then shows and focuses. Electron types via `import type` only.
       covers:     c-5, c-7
       contract:   if webPreferences lack contextIsolation:true, sandbox:true, nodeIntegration:false, or
                   set a preload, window.spec fails
       contract:   if window.open/target=_blank to 'https://www.amazon.co.uk/dp/B0X' or 'https://ntfy.sh/t'
                   returns anything but {action:'deny'}, or openExternal is not called exactly once with
                   that URL, window.spec fails
       contract:   if 'file:///etc/passwd', 'javascript:alert(1)', 'smb://h/s' or 'ms-msdt:x' reaches
                   shell.openExternal, window.spec's scheme table fails
       contract:   if will-navigate to 'https://evil.example/' or 'http://127.0.0.1:<other port>/' is not
                   prevented, a same-origin '/watches/1' navigation is prevented, or an off-origin
                   will-redirect is let through, window.spec fails
       contract:   if the window's 'close' event is preventDefault-ed (quit would hang behind it),
                   window.spec fails
       contract:   if showWindow after the window was destroyed does not create exactly one new window, a
                   minimised window is not restore()d, or showWindow on a visible window creates a second
                   BrowserWindow, window.spec fails

  t-6  Add start-at-login registration and toggle              [risk+verification+mvp]
       wave:       2
       depends_on: t-1
       files:      src/desktop/login-item.ts, src/desktop/login-item.spec.ts
       desc:       ensureRegisteredOnce (marker file in userData, written only after a real registration),
                   isLoginLaunch, isEnabled/setEnabled. darwin: setLoginItemSettings, detect via
                   wasOpenedAtLogin. win32: setLoginItemSettings with args ['--login-launch']. linux: XDG
                   autostart entry at $XDG_CONFIG_HOME (fallback ~/.config)/autostart/price-check.desktop,
                   Exec "<APPIMAGE|execPath>" --login-launch.
       covers:     c-6
       contract:   if a packaged first launch (no marker) on darwin/win32 does not call
                   setLoginItemSettings({openAtLogin:true}) exactly once (win32 with args
                   ['--login-launch']) and write the marker, login-item.spec fails
       contract:   if a launch with the marker present and the OS reporting openAtLogin:false (or the linux
                   file gone) calls setLoginItemSettings or writes an autostart file (re-asserting over a
                   user opt-out), login-item.spec fails
       contract:   if an unpackaged run on any platform registers anything, writes an autostart file or a
                   marker, login-item.spec fails
       contract:   if the linux entry's Exec for '/opt/Price Check/price-check' or a path containing a
                   double quote is not quoted per the Desktop Entry spec, or with APPIMAGE set Exec uses
                   process.execPath (the per-run /tmp/.mount_* path) instead of $APPIMAGE,
                   login-item.spec fails
       contract:   if isLoginLaunch is not true for argv containing '--login-launch' (win32/linux) and for
                   wasOpenedAtLogin (darwin), or true for a plain launch, login-item.spec fails
       contract:   if isEnabled reads the marker instead of OS state, win32 setEnabled(false) omits the
                   ['--login-launch'] args (Windows then leaves the registry entry), linux
                   setEnabled(false) leaves the file, or setEnabled(true) does not restore it on any
                   platform, login-item.spec fails
       contract:   if a throwing setLoginItemSettings or an unwritable autostart dir crashes startup or
                   writes the marker (so it is never retried), login-item.spec fails

  t-7  Add tray with Open, Start at login, Quit                [risk+verification]
       wave:       2
       depends_on: t-1
       files:      src/desktop/tray.ts, src/desktop/tray.spec.ts,
                   src/desktop/assets/tray-icon.png, src/desktop/assets/tray-iconTemplate.png
       desc:       createTray(deps, {showWindow, quitApp, loginItem, iconDir}) builds the menu from live OS
                   state, rebuilds after each toggle and returns a handle that holds the Tray reference.
                   loginItem is typed structurally ({isEnabled, setEnabled}), not imported from t-6.
                   iconDir is injected; t-9 resolves it from the app root (the bundle lives in
                   dist-desktop/, not next to the assets).
       covers:     c-5, c-6, c-9
       contract:   if the menu labels are not exactly ['Open', 'Start at login', 'Quit'] in order
                   (separators allowed), with Start at login a checkbox whose checked equals
                   loginItem.isEnabled(), tray.spec fails
       contract:   if clicking Open does not call showWindow once, or Quit calls anything but quitApp
                   (once), tray.spec fails
       contract:   if toggling Start at login does not call setEnabled(!current) and rebuild with the
                   re-read OS state, or a throwing setEnabled leaves the checkbox showing the failed state,
                   tray.spec fails
       contract:   if the darwin icon is not the Template file, or either icon file does not exist under
                   src/desktop/assets, tray.spec fails

  t-8  Wire lifecycle: instance, close, resume, quit          [risk+verification+mvp]
       wave:       2
       depends_on: t-1, t-2
       files:      src/desktop/lifecycle.ts, src/desktop/lifecycle.spec.ts
       desc:       runDesktop(deps) with every step injected through structural interfaces declared in this
                   file (no imports from window/tray/login-item/server/alerts-key; types only from
                   runtime-bridge): set userData, requestSingleInstanceLock, whenReady, loadKey,
                   startServer, read runtime, tray, register login item, window unless login launch.
                   Handlers for second-instance, window-all-closed (no-op), activate, powerMonitor resume
                   (runtime.requestPass), before-quit shutdown with a deadline, and startup failure.
       covers:     c-5, c-6, c-7, c-8, c-9
       contract:   if a lost single-instance lock still calls loadKey, startServer, createTray or
                   createWindow (a second DB/server/key access), or does not call app.quit, lifecycle.spec
                   fails
       contract:   if setPath('userData') is recorded after requestSingleInstanceLock in the call-order log
                   (the lock is keyed by userData), lifecycle.spec fails
       contract:   if 'second-instance' does not call showWindow, or 'activate' with no window does not,
                   lifecycle.spec fails
       contract:   if no 'window-all-closed' listener is registered (Electron's default quits on
                   Windows/Linux), or it calls app.quit, runtime.stop or server.close on win32, linux or
                   darwin, lifecycle.spec fails
       contract:   if a login launch creates a window, a normal launch creates other than one, the tray is
                   not created in both, or the login-item registration is not attempted once per startup,
                   lifecycle.spec fails
       contract:   if powerMonitor 'resume' does not call runtime.requestPass exactly once per event, the
                   listener is attached before whenReady resolves, or a disabled runtime (no-op controls)
                   makes it throw, lifecycle.spec fails
       contract:   if before-quit does not run exactly [runtime.stop, server.close, runtime.closeDb,
                   app.exit(0)] in that order, calls exit before closeDb resolves, runs again on a second
                   before-quit during shutdown, or a step that throws, rejects or hangs past the shutdown
                   deadline stops app.exit from being called, lifecycle.spec fails
       contract:   if a loadKey throw (bad key file) or a startServer rejection does not end in
                   dialog.showErrorBox (message names the file, contains no key base64) then app.exit(1)
                   with no tray created (a zombie instance would hold the lock and swallow every relaunch),
                   lifecycle.spec fails

Wave 3 (depends t-1..t-8)
  t-9  Wire Electron entry and import boundary                 [risk+mvp]
       wave:       3
       depends_on: t-1, t-2, t-3, t-4, t-5, t-6, t-7, t-8
       files:      src/desktop/main.ts, src/desktop/boundary.spec.ts, scripts/build-desktop.spec.ts,
                   package.json
       desc:       main.ts is the only value import of 'electron'. It passes the real app/BrowserWindow/Tray/
                   Menu/powerMonitor/shell/dialog, resolveUserDataDir, loadOrCreateAlertsKey, serverEnv,
                   loadAdapterHandler + startDesktopServer and the login item into runDesktop. It adds a
                   macOS app menu with role 'quit', resolves the app root and the handler URL from
                   import.meta.url (../build/handler.js), resolves the tray iconDir, and logs
                   '[desktop] listening on http://127.0.0.1:<port>' (the e2e seam). Script dev:desktop.
                   The executor runs pnpm check: structural-interface mismatches surface here.
       covers:     c-1, c-7
       contract:   if any non-spec src/desktop/**/*.ts other than main.ts has a non-type import of
                   'electron', boundary.spec fails
       contract:   if any file under src/lib or src/routes imports 'electron' or src/desktop, or any
                   non-spec file under src/desktop (src/desktop/testing excluded) imports $app/*,
                   @libsql/client or #lib/server/db/* (a second libsql client keeps the DB locked on
                   Windows), boundary.spec fails
       contract:   if building the real src/desktop/main.ts fails, or its bundle is missing the bare
                   'electron' import, keeps a '#lib/' or '$app/' specifier, or statically imports
                   build/handler.js (it must be a runtime dynamic import, after env is set),
                   build-desktop.spec 'real entry' fails

Wave 4 (depends t-9)
  t-10 Add Electron e2e harness and config split               [risk+verification]
       wave:       4
       depends_on: t-9
       files:      playwright.desktop.config.ts, playwright.config.ts, tsconfig.json,
                   e2e/desktop/launch.ts, e2e/desktop/harness.e2e.ts, scripts/build-desktop.spec.ts,
                   package.json
       desc:       launchDesktop({userData, args, scheduler}) via Playwright _electron on
                   dist-desktop/main.js (fails fast if it is missing), cwd a temp dir, env from an allowlist
                   (PATH, HOME, SystemRoot, TEMP, TMP, USERPROFILE, APPDATA, LOCALAPPDATA, DISPLAY,
                   XAUTHORITY, XDG_RUNTIME_DIR) plus PRICE_CHECK_USER_DATA, XDG_CONFIG_HOME=<temp> and
                   SCHEDULER_DISABLED=1 unless scheduler: 'unsupported-only'; never a process.env spread.
                   Waits for the listening line. spawnSecondInstance() and a raw node:http helper. Script
                   test:e2e:desktop builds web + desktop and then runs the desktop config. The desktop
                   config has workers 1, no webServer, testDir e2e/desktop. The default config
                   testIgnores e2e/desktop/**. tsconfig include gains playwright.desktop.config.ts.
       covers:     c-1, c-5, c-8
       contract:   if the default playwright config would collect e2e/desktop/*.e2e.ts (testIgnore check),
                   or playwright.desktop.config.ts has a webServer, workers ≠ 1, or matches anything
                   outside e2e/desktop, build-desktop.spec 'playwright config split' fails (vitest-gated)
       contract:   if, with the test process exporting DATABASE_URL=file:/elsewhere.db,
                   ALERTS_ENCRYPTION_KEY and ORIGIN, the launched main's process.env (electronApp.evaluate)
                   has SCHEDULER_DISABLED other than '1' on a default launch, a DATABASE_URL outside the
                   temp userData, the parent's key, or any ORIGIN, harness.e2e 'launcher env' fails
                   (r-01, c-1)
       contract:   if launchDesktop with scheduler: 'unsupported-only' starts Electron while the userData
                   DB holds a watch whose canonicalUrl defaultRegistry.identify() does not report
                   'unsupported' (an amazon.co.uk URL), harness.e2e fails: it must throw before launch
                   (r-01)
       contract:   if Electron's process.versions.node major (electronApp.evaluate) differs from
                   .node-version's major, harness.e2e fails

Wave 5 (depends t-10)
  t-11 Prove first launch, key reuse, quit, relaunch           [risk+verification+mvp]
       wave:       5
       depends_on: t-10
       files:      e2e/desktop/first-run.e2e.ts, e2e/desktop/quit-relaunch.e2e.ts
       desc:       Real Electron on an empty temp userData, cwd a temp dir holding a poisoned .env
                   (DATABASE_URL elsewhere). Saves an ntfy channel on a .invalid host through the window's
                   form (r-01), quits via app.quit(), relaunches immediately on the same userData.
       covers:     c-1, c-2, c-6, c-9
       contract:   if a fresh empty userData dir, with the poisoned .env in cwd and no env vars, does not
                   open a first window at http://127.0.0.1:<port>/ showing 'Nothing on your watchlist
                   yet.' within 30s, or leaves no alerts.key (32 bytes decoded) and price-check.db in that
                   userData (and none at the .env path), first-run.e2e fails
       contract:   if an unpackaged launch leaves a file under <XDG_CONFIG_HOME>/autostart (linux) or
                   openAtLogin true (darwin/win32, getLoginItemSettings), first-run.e2e fails
       contract:   if app.quit() does not end the process with code 0 within 10s, quit-relaunch.e2e fails
       contract:   if alerts.key's sha256 differs between launch 1 and launch 2, quit-relaunch.e2e fails
                   (c-2)
       contract:   if the relaunch started right after exit (no sleep; Windows CI included) fails to open
                   the DB, logs 'database is locked', or loses the channel or a watch inserted before the
                   first quit, quit-relaunch.e2e fails
       contract:   if, after relaunch, /account/alerts does not show launch 1's saved topic as readable, or
                   its ?/test action reports the save-first or could-not-be-decrypted message instead of
                   'Not delivered' (a send attempt that failed on the .invalid host), quit-relaunch.e2e
                   fails (c-2 "decrypt and send")

  t-12 Prove CSRF and Host guard in Electron                   [verification+risk+mvp]
       wave:       5
       depends_on: t-10
       files:      e2e/desktop/guard.e2e.ts
       desc:       Real Electron with the real built handler. POSTs come from inside the window via the
                   page's forms. Foreign requests go via raw node:http to the window's port.
       covers:     c-3, c-4
       contract:   if submitting the /account/alerts ntfy save form in the app window (.invalid topic) gets
                   403 or does not show the saved topic (Kit CSRF 403 because the origin was https),
                   guard.e2e fails
       contract:   if ?/add from the window's origin with an unsupported URL is 403 instead of 400,
                   guard.e2e fails (same-origin add-a-watch POST, no live fetch, r-01)
       contract:   if a raw POST to /account/alerts?/save or /?/add with Origin https://evil.example,
                   Origin https://127.0.0.1:<port> (wrong scheme), Origin 'null' or no Origin gets
                   anything but 403, or changes the stored channel, guard.e2e fails
       contract:   if a raw GET with Host 'evil.example' to a real file under build/client/_app/immutable/
                   (read from disk), /health or / gets anything but 403, guard.e2e fails; control: the same
                   asset with Host 127.0.0.1:<port> is 200 with an immutable cache-control
       contract:   if a TCP connect to the window's port on a non-loopback IPv4 of this machine
                   (os.networkInterfaces) succeeds, guard.e2e fails (test.skip when the host has none); two
                   launches on different userData dirs must get different ports

  t-13 Prove tray-close, single instance, resume, login launch [verification+risk+mvp]
       wave:       5
       depends_on: t-10
       files:      e2e/desktop/background.e2e.ts
       desc:       Real Electron. Scheduler-enabled runs (scheduler: 'unsupported-only') seed only
                   unsupported-URL watches (https://shop.e2e.invalid/…), so a pass records check failures
                   with no network.
       covers:     c-5, c-6, c-7, c-8
       contract:   if closing the only window (BrowserWindow.close via evaluate) ends the process, or
                   GET /health on its port 2s later is not 200, background.e2e 'close keeps serving' fails
       contract:   if, with the window closed, aging both watches' last_checked_at by 2 days (a separate
                   client on the userData DB, then closed) and emitting powerMonitor 'resume' does not add
                   a new failure row to each /watches/<id> within 10s, background.e2e fails ("checks keep
                   running" and resume catch-up)
       contract:   if a second instance spawned on the same userData does not exit 0 within 15s, or prints
                   a listening line of its own, background.e2e 'single instance' fails; afterwards the
                   first app must have exactly one visible window on the original port, also when its
                   window was closed first
       contract:   if a launch with '--login-launch' has any BrowserWindow once the server answers
                   /health, or a second launch then fails to open one, background.e2e 'login launch is
                   tray-only' fails

  t-14 Run desktop e2e in three-OS CI; gitleaks              [risk+verification+mvp]
       wave:       5
       depends_on: t-10
       files:      .github/workflows/ci.yml, scripts/ci-desktop.spec.ts, .gitleaks.toml,
                   scripts/gitleaks-config.spec.ts
       desc:       EXECUTOR: read ~/.claude/memory/reference_ci_supply_chain_hardening.md and
                   reference_ci_pipeline_optimisation.md first, audit ci.yml against them and report
                   findings. The test job adds a 'desktop e2e' step after e2e on all three OSes. Linux runs
                   'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0' and then 'xvfb-run -a
                   pnpm test:e2e:desktop'. Electron binary cache is keyed on pnpm-lock.yaml (existing
                   SHA-pinned actions/cache). Desktop reports join the failure upload. The static job sets
                   ELECTRON_SKIP_BINARY_DOWNLOAD=1. Permissions stay contents: read. .gitleaks.toml dross
                   tests.json entry gains ^\.dross/phases/03-desktop-shell/tests\.json$.
       covers:     c-1, c-2, c-3, c-4, c-5, c-6, c-7, c-8, c-9
       contract:   if ci.yml's test matrix loses linux, macos or windows, or the test job does not run
                   pnpm test:e2e:desktop on all three, ci-desktop.spec fails
       contract:   if the Linux desktop run is not under 'xvfb-run -a' (or lacks the AppArmor sysctl before
                   it), or the macOS/Windows runs are under xvfb-run, ci-desktop.spec fails
       contract:   if anything in ci.yml, src/desktop or e2e/desktop contains '--no-sandbox',
                   ci-desktop.spec fails
       contract:   if the static job lacks ELECTRON_SKIP_BINARY_DOWNLOAD=1, ci-desktop.spec fails
       contract:   if any new uses: is not SHA-pinned or permissions widen beyond contents: read,
                   pnpm ci:policy fails in the static job
       contract:   if any .dross/phases/<id>/ directory that has a spec.toml lacks its exact anchored
                   ^\.dross/phases/<id>/tests\.json$ path in the dross tests.json allowlist entry (03
                   included), gitleaks-config.spec 'every phase allowlisted' fails
```

### Coverage

| Criterion | Unit (commit-gated) | Real Electron e2e |
|---|---|---|
| c-1 empty userData, no setup | t-1, t-3, t-4 (chdir), t-9 | t-10, t-11 |
| c-2 key once, creds decrypt + send after relaunch | t-3 | t-11 |
| c-3 same-origin POST ok, foreign 403 | t-3, t-4 | t-12 |
| c-4 127.0.0.1 only, Host 403 incl. assets | t-4 | t-12 |
| c-5 close keeps tray, server, scheduler | t-5, t-7, t-8 | t-13 |
| c-6 login item once, tray-only login launch, toggle | t-6, t-7, t-8 | t-11 (no unpackaged registration), t-13 |
| c-7 single instance shows/reopens window | t-5, t-8, t-9 | t-13 |
| c-8 resume runs a catch-up pass | t-2, t-8 | t-13 |
| c-9 quit stops all, relaunch intact | t-2, t-4, t-7, t-8 | t-11 |

9/9 covered, each with at least one vitest-gated contract and one real-Electron contract. Locked decisions are covered as follows: server_port (t-4, t-12), desktop_server_wrapper (t-4, t-3 env, t-9), alerts_key_storage (t-3), login_start (t-6, t-8, t-11), window_close (t-5, t-8, t-13), external_links (t-5). t-14 carries the tests.json gitleaks entry.

Known risk shared by all three drafts and left unresolved: macOS `wasOpenedAtLogin` is deprecated on macOS 13+ (SMAppService). The darwin login-launch detection is unit-only and may report false on current macOS. Verification flagged this. No draft offers an alternative.

## Disagreements

1. **How the main process gets from TS to JS.** Risk and MVP bundle with esbuild. Risk outputs `dist-desktop/main.js` behind a separate `build:desktop` script. MVP outputs `build/desktop/main.js` chained into `pnpm build`. Verification compiles with `tsc -p tsconfig.desktop.json` to `build-desktop/` (no new dependency, relative `.ts` imports enforced by a scan). **Default: esbuild → `dist-desktop/` via `build:desktop` (risk).** Why it matters: esbuild inlines `#lib/*` and every transitive `src/lib` file. With tsc, any transitive `#lib` import outside `src/desktop` (which verification's scan does not cover) breaks at runtime, only in Electron. Chaining into `pnpm build` (MVP) would add the desktop bundle to every web build, including the Playwright webServer's.

2. **What closing the window does.** Risk destroys the window, makes `window-all-closed` a no-op and has `showWindow` recreate it. MVP and verification `preventDefault` the close and hide the window, with an `isQuitting` flag so Quit isn't blocked. **Default: destroy (risk), against the 2:1 majority.** Why it matters: hide-on-close keeps a Chromium renderer alive for the whole life of an always-running background app, and puts every quit path (before-quit, OS logout/shutdown) behind a flag whose one missed case is a Quit that hangs. Destroy drops page state on reopen, which matters little for a watchlist. If the human prefers hide, t-5's "close is never preventDefault-ed" contract becomes verification's pair ("prevented and hidden while not quitting / not prevented while quitting").

3. **Resume trigger.** Risk adds a coalescing `requestPass()` to the scheduler. MVP and verification call the existing `tick()`. **Default: requestPass (risk).** Why it matters: `tick()` returns `null` while a pass is running (checked in `scheduler.ts`). A resume that lands mid-pass is then dropped, and the watches that came due during sleep wait for the next 5-minute tick, which breaks c-8's "immediately".

4. **Linux CI sandbox.** Risk runs an AppArmor `sysctl` in the workflow and bans `--no-sandbox` repo-wide. MVP and verification pass `--no-sandbox` from the e2e harness on Linux CI only, and MVP rejects a privileged workflow step. **Default: sysctl + ban (risk), against the 2:1 majority.** Why it matters: with the sysctl, the e2e runs Electron with the same sandbox the shipped app has. The "privileged step" objection is weak because the job already runs `playwright install --with-deps` (sudo apt). If the sysctl proves insufficient on ubuntu-24.04, the fallback is the harness flag, and t-14's ban must then be scoped to `src/desktop` and `ci.yml`.

5. **End-to-end proof of c-5 "checks keep running" and c-8.** Verification runs a scheduler-enabled Electron with only unsupported-URL watches (no network, launcher guard against adapter-claimed URLs) and emits `powerMonitor 'resume'` via evaluate. Risk and MVP keep both unit-only: risk rejects a fake-shop switch, and MVP says sleep can't be faked. **Default: include (verification, t-13).** Why it matters: neither objection applies. No fake-shop switch is added, `checkUrl` on an unsupported URL does no network I/O (`registry.ts:65`), and emitting `resume` reaches the real listener. Without it, the real resume → runtime bridge → scheduler path never runs end-to-end. Residual risk: the second DB client that ages `last_checked_at` could meet "database is locked" on Windows if the app is mid-write.

6. **Granularity.** MVP has 6 tasks: window, tray, lifecycle and links merged into one lifecycle task, and all e2e + CI + gitleaks in one task. Risk has 12 and verification 13. **Default: fine-grained (14).** Why it matters: MVP's t-4 puts eight contracts behind one spec and one commit. A red there blocks c-5/6/7/8/9 together, and review per task becomes a whole-shell review.

7. **Where desktop e2e runs.** Risk and verification use a separate `playwright.desktop.config.ts` and script, and the default config ignores `e2e/desktop/**`. MVP puts `e2e/desktop.e2e.ts` in the default config and relies on its webServer build. **Default: separate config.** Why it matters: the default webServer seeds a shared DB and runs `pnpm preview`, which desktop runs must not share. `e2e/desktop.e2e.ts` would also sort before `e2e/harness.e2e.ts`, which relies on running first. A separate config also keeps a desktop failure in its own CI step.

8. **Electron typing in parallel modules.** Risk uses `import type … from 'electron'` (so window/login/tray wait for t-1, wave 2). MVP and verification declare local structural interfaces so those modules can run in wave 1. **Default: risk for window/login-item/tray (wave 2, after t-1). lifecycle (t-8) and tray's loginItem dep use structural types (MVP/verification), so wave-2 siblings never import each other.** Why it matters: this costs one wave but types window/tray against the real Electron API. Type mismatches in the structural seams surface only at t-9's `pnpm check`.

9. **Names and the location of the userData override.** The login-launch flag is `--hidden` (risk), `--login` (MVP) or `--login-launch` (verification). The override env var is `PRICE_CHECK_USER_DATA_DIR` (risk) or `PRICE_CHECK_USER_DATA` (MVP, verification). The override lives in app-paths.ts (risk), main.ts (MVP) or app.ts (verification). **Default: `--login-launch`, `PRICE_CHECK_USER_DATA`, in `app-paths.ts`.** Why it matters: only consistency across t-3/t-6/t-10/t-13. Keeping the override in a pure module keeps "packaged ignores it" unit-testable. Risk's `<appData>/price-check` naming is kept: Electron's default would be `price-check-app` from package.json.

10. **Closing the DB on quit.** Risk and verification publish `closeDb` and close it before `exit(0)`. MVP's quit is scheduler stop → server.close → exit, with no DB close. **Default: close (risk+verification).** Why it matters: c-9 requires an immediate Windows relaunch to open the same DB. An unclosed libsql handle at exit is the known Windows failure mode (spec defers only the updater variant to 05).

11. **CI cost and asset extras.** Risk sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` on the static job and ships real tray icons (Template on macOS). MVP rejects both as not traceable to a criterion. **Default: include (risk).** Why it matters: without the skip, the static job downloads the ~100 MB Electron binary on every PR only to lint and typecheck (the global CI pipeline-optimisation guidance applies). c-5/c-6 need a visible tray, and a missing macOS Template icon renders wrong in dark mode.

12. **Gitleaks entry: timing and scope.** Verification adds it in wave 1 (in the build scaffold task). Risk and MVP add it in the last task. Risk and verification generalise the spec to every `.dross/phases/<id>/`, while MVP checks the 03 row only. **Default: last task (t-14), generic check.** Why it matters: tests.json is only written by `dross verify` after execution, so the last task is still early enough. The generic check stops 04/05 from repeating the miss. Moving it out of t-1 keeps the build scaffold commit single-purpose.

## Commit-green check

- **t-1**: green. The new spec builds fixtures from stdin (no fixture file to lint or typecheck), and `scripts/` is in tsconfig with esbuild now a direct dep. The executor must run `pnpm install` after the onlyBuiltDependencies edit so 'electron binary installed' sees the binary. `main` pointing at a not-yet-built file touches nothing in vitest/lint/check.
- **t-2**: green. The `startScheduler` return change ships with its only consumer (hooks.server.ts), and hooks.server.spec's order expectation is updated in the same task. The db mock gains `$client.close` here.
- **t-3**: green. The specs import `#lib/server/alerts/crypto.ts` and `#lib/server/db/*` (allowed in specs). The awkward-path spec closes its client before temp-dir removal (Windows).
- **t-4**: green. `fake-handler.ts` is a non-spec helper that typechecks on its own. The chdir assertion restores cwd in afterEach (vitest forks pool, so chdir is permitted).
- **t-5**: green after t-1 (electron types installed).
- **t-6**: green after t-1.
- **t-7**: green after t-1. loginItem is typed structurally, so it does not depend on t-6 landing first. PNGs are outside prettier.
- **t-8**: green after t-1, t-2. **Fix applied:** lifecycle declares its own dep interfaces and imports types only from runtime-bridge, so it typechecks whichever wave-2 sibling lands first (risk left this open).
- **t-9**: green. **Fix applied:** boundary.spec scans non-spec files only and excludes `src/desktop/testing/`. As drafted, it would flag t-3's `server-env.spec.ts` (`#lib/server/db/*` import) and go red. main.ts is the first value import of electron. The executor must observe `pnpm check` green because the structural seams meet real types here.
- **t-10**: green. **Fix applied:** verification's playwright config-split assertions move from `scheduler.spec.ts` to `scripts/build-desktop.spec.ts` (vitest-gated, a topical host). `playwright.desktop.config.ts` joins tsconfig include in this task, the same task that creates it (verification had it in t-1, before the file existed). The `testIgnore` edit to playwright.config.ts is covered by that same spec.
- **t-11**: green. e2e-only files (outside the vitest gate) must pass prettier/eslint. The executor observes `pnpm test:e2e:desktop` locally before committing.
- **t-12**: green, same as t-11.
- **t-13**: green, same as t-11.
- **t-14**: green. **Fix applied:** risk's ci.yml assertions move out of `workflow-policy.spec.ts` (which only tests the checker on synthetic workflows and never reads the real ci.yml) into verification's new `scripts/ci-desktop.spec.ts`, landing with the ci.yml edit. The `--no-sandbox` scan passes because, under default 4, t-10's harness never adds the flag. gitleaks-config.spec's generic check passes because 01/02 are already listed and 03 is added in the same task.
