# 03-desktop-shell — risk-lens draft

Lens: every task owns a named set of failure modes and proves each with one test. The
risk register at the end maps each failure mode to the single task that owns it.

Layout choices this draft relies on (see Judgment calls):
- Main-process code lives in `src/desktop/` (already inside vitest's `server` project,
  tsconfig, eslint and prettier: no config edits needed before specs can run).
- Main process TypeScript is bundled by esbuild (`scripts/build-desktop.ts`, script
  `pnpm build:desktop`) into `dist-desktop/main.js` (ESM, `electron` external);
  `package.json` `main` points at it. Electron never runs `.ts`.
- Only `src/desktop/main.ts` value-imports `electron`; every other desktop module takes
  the Electron APIs as injected deps (`import type` only), so specs pass fakes.
- The server bundle's scheduler and its one libsql client are reached from main through
  a `globalThis[Symbol.for('price-check.runtime')]` bridge published by hooks `init`; the
  desktop never opens its own DB client.

```
Phase 03-desktop-shell — 12 tasks across 5 waves

Wave 1
  t-1  Add Electron toolchain and desktop bundle build
       files:    package.json, pnpm-lock.yaml, pnpm-workspace.yaml, .gitignore,
                 scripts/build-desktop.ts, scripts/build-desktop.spec.ts
       covers:   c-1
       desc:     electron + esbuild as exact-pinned devDependencies; onlyBuiltDependencies
                 [electron, esbuild]; build:desktop bundles an entry to dist-desktop/main.js
                 (ESM, platform node, electron external, #lib/* inlined) and rejects $app/*,
                 @libsql/*, drizzle-orm/libsql imports; package.json main = dist-desktop/main.js;
                 dist-desktop/ gitignored.
       contract: if pnpm-workspace.yaml onlyBuiltDependencies is not exactly ['electron','esbuild']
                 (a wildcard, a missing electron, or any extra package), build-desktop.spec fails
       contract: if electron's postinstall was denied, the path the 'electron' package exports does
                 not exist and build-desktop.spec 'electron binary installed' fails
       contract: if electron or esbuild carries a ^ or ~ range in package.json, build-desktop.spec fails
       contract: if a fixture entry importing 'electron' and '#lib/server/local-request.ts' builds to an
                 output that inlines electron, or still contains a '#lib/' specifier (Electron cannot
                 resolve it to .ts), build-desktop.spec fails
       contract: if a fixture entry importing '$app/env', '@libsql/client' or 'drizzle-orm/libsql'
                 builds instead of failing with an error naming the import, build-desktop.spec fails
       contract: if package.json main !== the build's outfile ('dist-desktop/main.js'), or the output
                 contains the repo's absolute path, build-desktop.spec fails

  t-2  Coalesce resume passes; publish runtime bridge
       files:    src/lib/server/scheduler.ts, src/lib/server/scheduler.spec.ts,
                 src/lib/server/runtime-bridge.ts, src/lib/server/runtime-bridge.spec.ts,
                 src/hooks.server.ts, src/hooks.server.spec.ts
       covers:   c-8, c-9
       desc:     Scheduler gains requestPass() (runs now if idle, else queues exactly one follow-up
                 pass) and an async stop(drainMs) that clears the interval and awaits the in-flight
                 pass up to drainMs. startScheduler returns {requestPass, stop} | null (consumer
                 hooks.server.ts in this task). hooks init publishes {requestPass, stop, closeDb} on
                 globalThis[Symbol.for('price-check.runtime')]; no-op controls when the scheduler
                 is disabled.
       contract: if requestPass() during a running pass is dropped (tick()'s overlap guard returns
                 null), scheduler.spec 'resume mid-pass' fails: after the running pass resolves exactly
                 one more pass must run, and its due(now) must receive the post-resume clock
       contract: if a fake clock jumps 8h (sleep) and the resume pass's due() is called with the
                 pre-sleep time, or a watch that came due during the jump is not checked, scheduler.spec
                 'due during sleep' fails
       contract: if two requestPass() calls during one pass yield two follow-up passes (pile-up), or a
                 requestPass() while idle does not start a pass synchronously, scheduler.spec fails
       contract: if stop() leaves the interval armed (a tick after stop under fake timers), or a pass
                 that never settles makes stop() hang past drainMs, scheduler.spec 'stop drains' fails
       contract: if two module instances (vi.resetModules + re-import, as the server bundle and the
                 main bundle are) do not see the same published runtime, or readRuntime() before
                 publish does anything but throw 'server runtime not published', runtime-bridge.spec fails
       contract: if closeDb() closes the client twice when called twice, runtime-bridge.spec fails
       contract: if hooks init order is not ['key','migrated','scheduler','published'], or a disabled
                 scheduler (startScheduler -> null) publishes no controls / controls whose stop()
                 rejects, hooks.server.spec fails

  t-3  First-launch bootstrap: paths, alerts key, server env
       files:    src/desktop/app-paths.ts, src/desktop/app-paths.spec.ts,
                 src/desktop/alerts-key.ts, src/desktop/alerts-key.spec.ts,
                 src/desktop/server-env.ts, src/desktop/server-env.spec.ts
       covers:   c-1, c-2
       desc:     resolveUserDataDir({appData, isPackaged, env}) -> <appData>/price-check, overridable
                 by PRICE_CHECK_USER_DATA_DIR only when unpackaged; desktopPaths -> dbFile, keyFile.
                 loadOrCreateAlertsKey(keyFile): mkdir -p, create via temp file + exclusive link
                 (mode 0600), never rewrite an existing key, refuse a bad one. serverEnv(inherited,
                 {dbFile, key}) builds the env the adapter handler is imported under.
       contract: if a second loadOrCreateAlertsKey on the same file returns different bytes, or the
                 file's content changes, alerts-key.spec 'never regenerated' fails; a value sealed with
                 encryptSecret under launch 1's key must decryptSecret under launch 2's key (c-2)
       contract: if an existing key file that is empty, truncated, non-base64 or 31/33 bytes decoded is
                 replaced instead of throwing an error that names the file path (and the file stays
                 byte-identical), alerts-key.spec 'bad key refused' fails
       contract: if two concurrent first-launch calls (Promise.all) return different keys, or a key
                 created between the existence check and the write is overwritten, alerts-key.spec fails
       contract: if a leftover 'alerts.key.tmp-*' from an interrupted write is read as the key or blocks
                 creation, alerts-key.spec fails
       contract: on POSIX (skipIf win32), if the created file's mode & 0o777 !== 0o600, alerts-key.spec
                 fails; if any thrown message contains the key's base64, alerts-key.spec fails
       contract: if a missing nested userData dir makes first launch throw, alerts-key.spec fails
       contract: if packaged resolveUserDataDir honours PRICE_CHECK_USER_DATA_DIR, or the dir name is not
                 exactly 'price-check' under appData, app-paths.spec fails
       contract: if inherited ORIGIN, HOST_HEADER, PORT_HEADER, ADDRESS_HEADER survive serverEnv, or an
                 inherited PROTOCOL_HEADER/DATABASE_URL/ALERTS_ENCRYPTION_KEY wins over the desktop's own
                 values (PROTOCOL_HEADER must be 'x-forwarded-proto'), server-env.spec fails
       contract: if SCHEDULER_DISABLED or CHECK_INTERVAL_HOURS are not passed through, server-env.spec fails
       contract: if DATABASE_URL for a userData dir named 'Application Support Zoë #1 50%' does not let
                 createDb + migrateDb create exactly <dir>/price-check.db (existsSync true, no stray file
                 in cwd), server-env.spec 'awkward path' fails

  t-4  Loopback http wrapper around adapter handler
       files:    src/desktop/server.ts, src/desktop/server.spec.ts,
                 src/desktop/testing/fake-handler.ts
       covers:   c-3, c-4, c-9
       desc:     startDesktopServer({handler}) listens on 127.0.0.1 port 0; every request: Host checked
                 with isLoopbackHost first (403 text, handler never called), client X-Forwarded-Proto /
                 X-Forwarded-Host removed, X-Forwarded-Proto set to 'http', then handler(req,res).
                 close() ends idle keep-alive sockets. loadAdapterHandler(env, moduleUrl) assigns env
                 to process.env BEFORE dynamically importing the module.
       contract: if server.address() is not {address:'127.0.0.1', family IPv4, port>0}, or two starts
                 share a port, server.spec fails; if a non-internal IPv4 interface exists, connecting to
                 it at that port must be refused
       contract: if a request with Host 'evil.example' to '/_app/immutable/chunks/x.js', '/health' or '/'
                 reaches the handler, or gets anything but 403, server.spec's host table fails; a raw
                 request with no Host must also 403; Host '127.0.0.1:<port>' and 'localhost:<port>' pass
       contract: if a client-sent 'X-Forwarded-Proto: https' (or 'https, http') reaches the handler as
                 anything but exactly 'http', or X-Forwarded-Host survives, server.spec fails
       contract: if close() with an idle keep-alive connection open takes over 1s (server.close waiting
                 on Chromium's sockets: quit would hang), server.spec 'close with keep-alive' fails
       contract: if loadAdapterHandler imports a fixture module (src/desktop/testing/fake-handler.ts,
                 which records process.env.PROTOCOL_HEADER at top level) before assigning env, the
                 recorded value is not 'x-forwarded-proto' and server.spec 'env before import' fails
                 (adapter-node reads PROTOCOL_HEADER and runs hooks init at import time)

Wave 2 (depends t-1; t-8 also t-2)
  t-5  Main window with external-link and navigation policy
       files:    src/desktop/window.ts, src/desktop/window.spec.ts
       covers:   c-5, c-7
       desc:     createMainWindow(deps, origin): contextIsolation true, nodeIntegration false,
                 sandbox true, no preload; setWindowOpenHandler always denies (http/https off-origin ->
                 shell.openExternal; same-origin -> load in this window); will-navigate and will-redirect
                 off-origin are prevented. showWindow(state) recreates a destroyed/never-created
                 window, restores a minimised one, shows and focuses.
       contract: if webPreferences lack contextIsolation:true, sandbox:true, nodeIntegration:false, or
                 set a preload, window.spec fails
       contract: if window.open/target=_blank 'https://www.amazon.co.uk/dp/B0X' returns anything but
                 {action:'deny'} or openExternal is not called exactly once with that URL, window.spec fails
       contract: if 'file:///etc/passwd', 'javascript:alert(1)', 'smb://h/s' or 'ms-msdt:x' reaches
                 shell.openExternal, window.spec's scheme table fails
       contract: if will-navigate to 'https://evil.example/' or 'http://127.0.0.1:<other port>/' is not
                 prevented, a same-origin '/watches/1' navigation is prevented, or a will-redirect
                 off-origin is let through, window.spec fails
       contract: if showWindow after the window was destroyed does not create exactly one new window, a
                 minimised window is not restore()d, or showWindow on a visible window creates a second
                 BrowserWindow, window.spec fails

  t-6  Start-at-login: register once, per platform
       files:    src/desktop/login-item.ts, src/desktop/login-item.spec.ts
       covers:   c-6
       desc:     ensureRegisteredOnce (marker file in userData), isLoginLaunch, isEnabled/setEnabled.
                 darwin: setLoginItemSettings, detect via wasOpenedAtLogin. win32: setLoginItemSettings
                 with args ['--hidden']. linux: XDG autostart entry at $XDG_CONFIG_HOME (fallback
                 ~/.config)/autostart/price-check.desktop, Exec <exe> --hidden.
       contract: if a packaged first launch (no marker) on darwin/win32 does not call
                 setLoginItemSettings({openAtLogin:true}) exactly once (win32 with args ['--hidden']) and
                 write the marker, login-item.spec fails
       contract: if a launch with the marker present and the OS reporting openAtLogin:false calls
                 setLoginItemSettings or writes an autostart file (re-asserting over a user opt-out),
                 login-item.spec fails
       contract: if an unpackaged run on any platform registers anything, writes an autostart file or a
                 marker, login-item.spec fails
       contract: if the linux entry's Exec for '/opt/Price Check/price-check' is not quoted per the
                 Desktop Entry spec, or with APPIMAGE set Exec uses process.execPath (the per-run
                 /tmp/.mount_* path) instead of $APPIMAGE, login-item.spec fails
       contract: if isLoginLaunch is not true for argv containing '--hidden' (win32/linux) and for
                 wasOpenedAtLogin (darwin), or true for a plain launch, login-item.spec fails
       contract: if isEnabled reads the marker instead of OS state, or win32 setEnabled(false) omits the
                 ['--hidden'] args (Windows then leaves the registry entry), or linux setEnabled(false)
                 leaves the file, login-item.spec fails
       contract: if a throwing setLoginItemSettings / unwritable autostart dir crashes startup or writes
                 the marker (so it is never retried), login-item.spec fails

  t-7  Tray with Open, Start at login, Quit
       files:    src/desktop/tray.ts, src/desktop/tray.spec.ts,
                 src/desktop/assets/tray-icon.png, src/desktop/assets/tray-iconTemplate.png
       covers:   c-5, c-6
       desc:     createTray(deps, {showWindow, quitApp, loginItem}) builds the menu from live OS
                 state; rebuilds after each toggle; returns a handle that holds the Tray reference.
       contract: if the menu labels are not exactly ['Open', 'Start at login', 'Quit'] with Start at login
                 a checkbox whose checked equals loginItem.isEnabled(), tray.spec fails
       contract: if clicking Open does not call showWindow, or Quit calls anything but quitApp, tray.spec fails
       contract: if toggling Start at login does not call setEnabled(!current) and rebuild with the
                 re-read OS state, or a throwing setEnabled leaves the checkbox showing the failed state,
                 tray.spec fails
       contract: if the icon path for darwin is not the Template file, or either icon path does not exist
                 on disk (relative to the module, as the bundle resolves it), tray.spec fails

  t-8  Lifecycle: single instance, close, resume, quit, failure
       files:    src/desktop/lifecycle.ts, src/desktop/lifecycle.spec.ts
       covers:   c-5, c-6, c-7, c-8, c-9
       desc:     runDesktop(deps) with every step injected: set userData, requestSingleInstanceLock,
                 whenReady, loadKey, start server, tray, window unless login launch; handlers for
                 second-instance, window-all-closed (no-op), activate, powerMonitor resume, before-quit
                 shutdown, startup failure.
       contract: if a lost single-instance lock still calls loadKey, startServer, createTray or
                 createWindow (a second DB/server/key access), or does not call app.quit, lifecycle.spec fails
       contract: if userData is set after requestSingleInstanceLock (the lock is keyed by userData),
                 lifecycle.spec's call-order assertion fails
       contract: if 'second-instance' does not call showWindow, or 'activate' with no window does not,
                 lifecycle.spec fails
       contract: if 'window-all-closed' on win32, linux or darwin calls app.quit, runtime.stop or
                 server.close, lifecycle.spec fails
       contract: if a login launch creates a window, or a normal launch creates other than one,
                 lifecycle.spec fails
       contract: if powerMonitor 'resume' does not call runtime.requestPass once per event, or the
                 listener is attached before whenReady resolves, lifecycle.spec fails
       contract: if before-quit does not run exactly [runtime.stop, server.close, runtime.closeDb,
                 app.exit(0)] in that order, a second before-quit during shutdown runs it again, or a
                 step that throws or hangs past the shutdown deadline stops app.exit from being called,
                 lifecycle.spec fails
       contract: if a loadKey throw (bad key file) or a startServer rejection does not end in
                 dialog.showErrorBox (message names the file, contains no key base64) then app.exit(1)
                 with no tray created (a zombie instance would hold the lock and swallow every relaunch),
                 lifecycle.spec fails

Wave 3 (depends t-1, t-3, t-4, t-5, t-6, t-7, t-8)
  t-9  Wire Electron entry and desktop import boundary
       files:    src/desktop/main.ts, src/desktop/boundary.spec.ts, scripts/build-desktop.spec.ts,
                 package.json
       covers:   c-1, c-7
       desc:     main.ts: the only value import of 'electron'; passes real app/BrowserWindow/Tray/
                 Menu/powerMonitor/shell/dialog into runDesktop; macOS app menu with role 'quit';
                 handler URL resolved from import.meta.url to ../build/handler.js; logs
                 '[desktop] listening on http://127.0.0.1:<port>' (e2e seam). Script dev:desktop.
       contract: if any src/desktop/*.ts other than main.ts has a non-type import of 'electron' (under
                 vitest that import is a path string, not the API), boundary.spec fails
       contract: if any file under src/lib or src/routes imports 'electron' or src/desktop, or any
                 src/desktop file imports $app/*, @libsql/client or #lib/server/db/* (a second libsql
                 client keeps the DB locked on Windows), boundary.spec fails
       contract: if building the real src/desktop/main.ts fails, or its bundle has a bare 'electron'
                 import missing, a '#lib/' or '$app/' specifier, or a static import of build/handler.js
                 (it must be a runtime dynamic import), build-desktop.spec 'real entry' fails

Wave 4 (depends t-9)
  t-10 Electron e2e harness, first run, guard
       files:    playwright.desktop.config.ts, playwright.config.ts, e2e/desktop/launch.ts,
                 e2e/desktop/first-run.e2e.ts, e2e/desktop/guard.e2e.ts, package.json
       covers:   c-1, c-3, c-4
       desc:     launchDesktop({userDataDir, args}) via Playwright _electron on dist-desktop/main.js,
                 env from an allowlist (PATH, HOME, SystemRoot, TEMP, TMP, DISPLAY, XDG_RUNTIME_DIR)
                 plus SCHEDULER_DISABLED=1, PRICE_CHECK_USER_DATA_DIR, XDG_CONFIG_HOME=<temp>; cwd a
                 temp dir; waits for the listening line. Script test:e2e:desktop builds web + desktop
                 then runs the desktop config; the default config ignores e2e/desktop/**.
       contract: if the launched main process (electronApp.evaluate(() => process.env)) has
                 SCHEDULER_DISABLED other than '1', or sees DATABASE_URL, ALERTS_ENCRYPTION_KEY or ORIGIN
                 set in the test process, first-run.e2e 'launcher env' fails (r-01, c-1)
       contract: if a fresh empty userData dir, with a poisoned .env (DATABASE_URL elsewhere) in cwd, does
                 not open a first window at http://127.0.0.1:<port>/ showing 'Nothing on your watchlist
                 yet.', or leaves no alerts.key (32 bytes decoded) and price-check.db in that userData,
                 first-run.e2e fails
       contract: if XDG_CONFIG_HOME/autostart gains a file after an unpackaged launch, first-run.e2e fails
       contract: if saving a .invalid ntfy topic through the /account/alerts form in the window does not
                 show the saved topic (Kit CSRF 403 because the origin was https), guard.e2e fails
       contract: if a POST to /account/alerts?/save with Origin https://evil.example is not 403 with Kit's
                 'Cross-site POST form submissions are forbidden', or changes the stored channel,
                 guard.e2e fails
       contract: if a raw node:http GET of a real /_app/immutable/* asset (taken from the page) with Host
                 'evil.example' is not 403, or the same asset with Host '127.0.0.1:<port>' is not 200,
                 guard.e2e fails; two launches on different userData dirs must get different ports
       contract: if the default playwright config picks up e2e/desktop/** (the web webServer run would
                 launch Electron), or the desktop config matches anything outside it, first-run.e2e
                 'config split' fails

Wave 5 (depends t-10)
  t-11 E2E close-to-tray, relaunch, login launch, quit
       files:    e2e/desktop/lifecycle.e2e.ts, e2e/desktop/quit-relaunch.e2e.ts
       covers:   c-2, c-5, c-6, c-7, c-9
       desc:     Real Electron: close window, second instance, --hidden launch, quit via app.quit()
                 then immediate relaunch on the same userData.
       contract: if closing the only window ends the process, or GET /health on its port 2s later is not
                 200, lifecycle.e2e 'close keeps serving' fails
       contract: if a second launch on the same userData does not exit with code 0 within 10s, prints a
                 listening line of its own, or the first app does not emit a new window on the original
                 port, lifecycle.e2e 'single instance' fails
       contract: if a launch with '--hidden' opens any window after its listening line, or a second
                 launch then fails to open one, lifecycle.e2e 'login launch is tray-only' fails
       contract: if app.quit() does not end the process with code 0 within 10s, or an immediate relaunch
                 on the same userData (Windows runner included) does not show launch 1's saved ntfy
                 topic as readable, quit-relaunch.e2e fails
       contract: if alerts.key's sha256 differs between launch 1 and launch 2, quit-relaunch.e2e fails (c-2)

  t-12 Run desktop e2e in CI; gitleaks 03
       files:    .github/workflows/ci.yml, scripts/workflow-policy.spec.ts, .gitleaks.toml,
                 scripts/gitleaks-config.spec.ts
       covers:   c-9
       desc:     EXECUTOR: read ~/.claude/memory/reference_ci_supply_chain_hardening.md first and audit
                 ci.yml against it. Test job adds a 'desktop e2e' step on all three OSes: Linux runs
                 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0' then 'xvfb-run -a
                 pnpm test:e2e:desktop'; static job sets ELECTRON_SKIP_BINARY_DOWNLOAD=1. All actions
                 stay SHA-pinned, permissions contents: read. .gitleaks.toml gains
                 ^\.dross/phases/03-desktop-shell/tests\.json$.
       contract: if ci.yml's test job does not run pnpm test:e2e:desktop on linux, macos and windows,
                 runs it on Linux without 'xvfb-run -a', or anything in ci.yml, src/desktop or e2e/desktop
                 contains '--no-sandbox', workflow-policy.spec fails
       contract: if the static job lacks ELECTRON_SKIP_BINARY_DOWNLOAD=1, workflow-policy.spec fails
       contract: if any directory under .dross/phases/ lacks its exact anchored tests.json path in the
                 dross-survivor allowlist entry, gitleaks-config.spec 'every phase allowlisted' fails
       contract: if pnpm ci:policy (SHA pins, read-only token) rejects ci.yml, workflow-policy.spec's
                 existing whole-repo check fails
```

## Coverage

| Criterion | Tasks |
|---|---|
| c-1 empty userData, no setup | t-1, t-3, t-9, t-10 |
| c-2 key once, creds survive relaunch | t-3, t-11 |
| c-3 same-origin POST ok, foreign 403 | t-4, t-10 |
| c-4 127.0.0.1 only, Host 403 incl. assets | t-4, t-10 |
| c-5 close keeps tray, server, scheduler | t-5, t-7, t-8, t-11 |
| c-6 login item, tray-only login launch, toggle | t-6, t-7, t-8, t-11 |
| c-7 single instance shows window | t-5, t-8, t-9, t-11 |
| c-8 resume runs a pass | t-2, t-8 |
| c-9 quit ends process, relaunch intact | t-2, t-4, t-8, t-11, t-12 |

All 9/9 covered. Locked decisions: server_port (t-4), desktop_server_wrapper (t-4, t-3 env),
alerts_key_storage (t-3), login_start (t-6), window_close (t-5, t-8), external_links (t-5).

## Risk register (one owner each)

| Failure mode | Owner |
|---|---|
| pnpm 10 denies electron postinstall; binary missing | t-1 |
| Main bundle inlines electron / keeps #lib or $app specifiers | t-1 (fixture), t-9 (real entry) |
| Resume skipped because a pass was mid-flight | t-2 |
| Two bundles see different scheduler/db instances | t-2 |
| Stop hangs on an in-flight check | t-2 |
| Key regenerated or overwritten, corrupt key silently replaced | t-3 |
| Key perms, key bytes in error text | t-3 |
| User env (ORIGIN, *_HEADER, DATABASE_URL, key) hijacks the server | t-3 |
| userData path with space / non-ASCII / # / % breaks the libsql URL | t-3 |
| Env applied after handler import -> https origin -> CSRF 403 | t-4 |
| sirv serves /_app/immutable before Host guard | t-4 |
| Spoofed X-Forwarded-Proto | t-4 |
| Keep-alive sockets hang server.close on quit | t-4 |
| openExternal on file:/javascript:/smb: (code execution) | t-5 |
| Shop page loads inside the app window | t-5 |
| Re-registering login item undoes user opt-out | t-6 |
| AppImage mount path / unquoted Exec in autostart | t-6 |
| Windows unregister needs matching args | t-6 |
| Tray checkbox drifts from OS state | t-7 |
| Second instance touches key/DB before lock check | t-8 |
| window-all-closed quits on Windows/Linux | t-8 |
| Double Quit, or hung shutdown never exits | t-8 |
| Startup failure leaves a zombie that swallows relaunches | t-8 |
| desktop code opens its own libsql client (Windows lock) | t-9 |
| e2e leaks dev env / runs scheduler (r-01) / registers login item | t-10 |
| Windows process not fully gone before relaunch | t-11 |
| Linux CI: no display, AppArmor userns blocks the Chromium sandbox | t-12 |
| tests.json gitleaks miss for this or a future phase | t-12 |

## Judgment calls

- Desktop code in `src/desktop/`, not a top-level `desktop/`: already covered by vitest's server project, tsconfig, eslint; rejected a new dir because it needs vite.config/tsconfig edits before any desktop spec can run and pushes t-3/t-4 out of wave 1. The bundling-direction risk is closed by t-9's boundary spec instead.
- esbuild bundle (explicit devDependency, already in onlyBuiltDependencies) over Node type stripping inside Electron: Electron's bundled Node and its strip-types flag are not guaranteed, and the #lib imports map would resolve to .ts files at runtime. Rejected `vite build` for main: a second Kit-free vite config is more surface than one esbuild call.
- Window close destroys the window (handle `window-all-closed` as a no-op) rather than hide + preventDefault on close: the preventDefault pattern is the classic cause of Quit hanging on macOS/Windows. showWindow recreates it.
- Scheduler controls reach main through a `Symbol.for` globalThis bridge published by hooks init, not by main building its own scheduler/db: a second libsql client breaks the Windows lock rule, and the scheduler must share the server's client.
- requestPass() coalescing added to the scheduler rather than calling tick() on resume: tick() returns null when a pass is running, so a resume during a pass would silently skip the watches that came due in sleep (c-8).
- ALERTS_ENCRYPTION_KEY handed to the server via process.env (set before handler import) rather than a new key-file env var read by hooks: keeps hooks' key loading unchanged; Electron child processes inheriting it exposes nothing the same-user 0600 file does not.
- First-launch marker file for login registration instead of using key-file absence: decouples the two so a failed registration can retry without touching the key, and a key restore never re-registers.
- c-5 "scheduled checks keep running" and c-8 are proven at unit level only (t-2, t-8): every Electron e2e runs with SCHEDULER_DISABLED=1 (r-01), and resume cannot be triggered on CI runners. Rejected a test-only fake-shop switch in the production bundle.
- c-3's same-origin POST is proven with the ntfy channel save (.invalid topic, never sends) rather than adding a watch: adding a watch fetches Amazon live (r-01).
- Linux CI unblocks the Chromium sandbox with the AppArmor sysctl rather than `--no-sandbox`: the shipped app must never need the switch, and t-12 bans it repo-wide.
- Separate `playwright.desktop.config.ts` rather than adding desktop specs to the existing config: the web config's webServer seeds and previews a shared DB the desktop runs must not touch, and a desktop failure stays isolated in its own CI step.
- gitleaks: generalise the spec to "every .dross/phases/* dir has its tests.json path" instead of only adding 03, so the next phase cannot miss it either.
