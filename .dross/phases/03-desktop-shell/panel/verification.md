# 03-desktop-shell — verification-lens draft

Method: each criterion's ideal test contract was written first (unit with injected
fakes where Electron can't be driven, real-Electron e2e where it can), then the
smallest task that makes that contract satisfiable. Main-process modules live in
`src/desktop/` so the existing vitest `server` project (`src/**/*.spec.ts`) picks
their specs up with no config change. Every module except `main.ts` takes its
Electron APIs as narrow, locally declared structural interfaces (no `import type
… from 'electron'`), so wave-1 specs pass plain-object fakes and do not need the
electron package installed.

How Electron runs the TypeScript: `tsc -p tsconfig.desktop.json` compiles
`src/desktop/**/*.ts` (specs excluded) to `build-desktop/` (rootDir `.`,
module/moduleResolution `nodenext`, `rewriteRelativeImportExtensions: true`), and
package.json `"main": "build-desktop/src/desktop/main.js"`. No new bundler
dependency. `pnpm desktop:build` = `pnpm build && tsc -p tsconfig.desktop.json`.
At runtime the main process sets the server env, `chdir(app.getAppPath())`, then
`await import(<appPath>/build/handler.js)` (adapter-node's handler, which runs
Kit's `init` hook at module load). The wrapper `node:http` server Host-checks
every request, then overwrites `x-forwarded-proto: http` and calls the handler,
with `PROTOCOL_HEADER=x-forwarded-proto` in env: adapter-node's `get_origin` then
yields `http://127.0.0.1:<live port>`. The Kit bundle's scheduler and db client
reach the main process through a `Symbol.for('price-check.runtime')` slot that
`hooks.server.ts` `init` fills (one long-lived libsql client, the Kit bundle's own).

```
Phase 03-desktop-shell — 13 tasks across 4 waves

Wave 1
  t-1  Add electron dep and desktop build scaffold
       files:    package.json, pnpm-lock.yaml, pnpm-workspace.yaml, tsconfig.desktop.json,
                 tsconfig.json, .gitignore, .gitleaks.toml, scripts/desktop-build.spec.ts,
                 scripts/gitleaks-config.spec.ts
       desc:     electron as an exact-pinned devDependency (newest stable whose bundled Node
                 major equals .node-version's 24) and added to onlyBuiltDependencies; package.json
                 "main" + scripts desktop:build / desktop / test:desktop; tsconfig.desktop.json
                 as above; /build-desktop gitignored (so prettier and eslint skip it);
                 playwright.desktop.config.ts added to tsconfig include (file lands in t-9).
                 .gitleaks.toml gains ^\.dross/phases/03-desktop-shell/tests\.json$ in the
                 dross tests.json entry.
       covers:   c-1
       contract: if pnpm-workspace.yaml onlyBuiltDependencies is not exactly ['electron', 'esbuild']
                 (a third build-script package slips in, or electron is missing so its binary
                 never downloads), desktop-build.spec fails
       contract: if package.json's electron version carries ^, ~, a range or a tag instead of an
                 exact x.y.z, desktop-build.spec fails
       contract: if package.json "main" is not the path tsc emits for src/desktop/main.ts under
                 tsconfig.desktop.json's outDir/rootDir (computed from the tsconfig, not
                 hard-coded), or rewriteRelativeImportExtensions is not true, desktop-build.spec
                 fails
       contract: if any non-spec file under src/desktop/ imports '#lib/…', '$app/…', '$env/…' or a
                 relative path not ending in '.ts' (each breaks once compiled and run by Electron),
                 desktop-build.spec's import scan fails
       contract: if .gitignore does not ignore /build-desktop, desktop-build.spec fails
       contract: if any .dross/phases/<id>/ directory that has a spec.toml lacks the exact path
                 ^\.dross/phases/<id>/tests\.json$ in the generic-api-key "Key" allowlist entry
                 (03 included), gitleaks-config.spec's new 'every phase tests.json is
                 allowlisted' case fails

  t-2  Generate alerts key; build desktop server env
       files:    src/desktop/user-data.ts, src/desktop/user-data.spec.ts
       desc:     loadOrCreateAlertsKey(dir): if <dir>/alerts.key exists, read it and
                 parseAlertsKey (relative import of src/lib/server/alerts/crypto.ts), never
                 rewrite it; else write base64 of randomBytes(32) with flag 'wx' and mode 0o600.
                 desktopServerEnv({ userData, key, inherited }) returns the env the handler must
                 see: DATABASE_URL=file:<userData>/price-check.db, ALERTS_ENCRYPTION_KEY,
                 PROTOCOL_HEADER=x-forwarded-proto, inherited ORIGIN removed.
       covers:   c-1, c-2, c-3
       contract: if a second loadOrCreateAlertsKey(dir) returns different bytes than the first, or
                 the file's sha256 changes between the calls, user-data.spec fails
       contract: if a present but corrupt alerts.key (truncated base64, 16 bytes) is regenerated
                 instead of throwing AlertsKeyError with the file left byte-identical,
                 user-data.spec fails (regeneration would orphan every saved credential)
       contract: if on POSIX the new file's mode & 0o777 is not 0o600, user-data.spec fails
                 (it.skipIf win32)
       contract: if two concurrent first calls on an empty dir return different keys (no 'wx'
                 exclusive create), user-data.spec fails
       contract: if the thrown error's message contains the file's contents, user-data.spec fails
       contract: if desktopServerEnv with inherited { DATABASE_URL: 'file:/elsewhere.db',
                 ALERTS_ENCRYPTION_KEY: '<other>', ORIGIN: 'https://evil.example' } does not
                 return DATABASE_URL pointing into userData, the generated key, no ORIGIN key at
                 all, and PROTOCOL_HEADER === 'x-forwarded-proto', user-data.spec fails

  t-3  Add Host-checking http wrapper for the handler
       files:    src/desktop/server.ts, src/desktop/server.spec.ts
       desc:     startDesktopServer({ handler }) listens on 127.0.0.1 port 0; each request:
                 isLoopbackHost(req.headers.host) (relative import of local-request.ts) else
                 plain 403 without calling the handler; otherwise set
                 req.headers['x-forwarded-proto'] = 'http' (overwriting any client value) and
                 call handler(req, res). Returns { port, url, close() } where close() also ends
                 keep-alive sockets (closeAllConnections).
       covers:   c-3, c-4
       contract: if a request with Host 'evil.example' to /_app/immutable/entry/app.js,
                 /health or / reaches the fake handler (call count > 0) or gets anything but 403,
                 server.spec fails — the path the sirv-before-hooks gap left open
       contract: if a request with no Host header (setHost: false) reaches the handler,
                 server.spec fails
       contract: if Host '127.0.0.1:<port>' with a client-sent 'x-forwarded-proto: https' does
                 not reach the handler with headers['x-forwarded-proto'] === 'http' (exactly one
                 value), server.spec fails
       contract: if server.address().address is not '127.0.0.1', or two started servers share a
                 port or report port 0, server.spec fails (fixed port or 0.0.0.0/:: bind)
       contract: if close() has not resolved within 1s while a keep-alive client socket is open,
                 or the port still accepts a connection afterwards, server.spec fails

  t-4  Expose scheduler tick/stop and db close to main
       files:    src/lib/server/scheduler.ts, src/lib/server/scheduler.spec.ts,
                 src/lib/server/runtime.ts, src/lib/server/runtime.spec.ts, src/hooks.server.ts,
                 src/hooks.server.spec.ts
       desc:     startScheduler returns { tick, stop } | null; stop() clears the interval and
                 resolves after any in-flight pass settles. New runtime.ts:
                 publishRuntime/takeRuntime on globalThis[Symbol.for('price-check.runtime')]
                 (no $app imports). hooks init publishes { tick, stop, closeDb } — tick/stop
                 no-ops when the scheduler is null, closeDb = db.$client.close().
       covers:   c-8, c-9
       contract: if, with three watches last checked at t0 and now() jumped to t0 + 3 intervals
                 (a sleep), one tick() of a scheduler over a migrated test DB does not call
                 checkOne for all three in one pass, scheduler.spec's 'catch-up after sleep'
                 fails
       contract: if stop() resolves while a checkOne is still pending (deferred promise not yet
                 resolved), scheduler.spec fails — quit would close the db under a running pass
       contract: if, after stop(), advancing fake timers by 3 × TICK_MS calls due() again,
                 scheduler.spec fails
       contract: if takeRuntime() from a separately loaded module instance (vi.resetModules +
                 re-import) does not return what publishRuntime stored, runtime.spec fails
                 (a module-local variable instead of the Symbol.for slot)
       contract: if hooks init does not publish a runtime whose tick and stop are the
                 startScheduler result's, whose closeDb calls the db's $client.close, or whose
                 tick returns null without throwing when startScheduler returned null
                 (SCHEDULER_DISABLED), hooks.server.spec fails; init order stays
                 ['key', 'migrated', 'scheduler', 'published']

  t-5  Add start-at-login registration and toggle
       files:    src/desktop/login-item.ts, src/desktop/login-item.spec.ts
       desc:     createLoginItem({ platform, isPackaged, execPath, configHome, markerFile, app })
                 → { registerOnFirstLaunch(), isEnabled(), setEnabled(on) } plus
                 isLoginLaunch({ platform, argv, loginItemSettings }). macOS/Windows use
                 app.setLoginItemSettings (Windows args ['--login-launch']); Linux writes
                 <configHome>/autostart/price-check.desktop with Exec="<execPath>" --login-launch.
                 A marker file records the one registration.
       covers:   c-6
       contract: if a packaged first launch (no marker) on darwin/win32 does not call
                 setLoginItemSettings exactly once with openAtLogin true (win32 also
                 args ['--login-launch']), or on linux does not write an autostart file whose
                 Exec line quotes the execPath and ends in --login-launch, login-item.spec's
                 per-platform table fails
       contract: if a second launch (marker present) with the OS item since turned off calls
                 setLoginItemSettings or rewrites the autostart file, login-item.spec fails
                 (re-asserting would undo the user's opt-out)
       contract: if an unpackaged launch on any platform calls setLoginItemSettings, writes an
                 autostart file or writes the marker, login-item.spec fails
       contract: if setEnabled(false) then isEnabled() is not false (linux: file gone;
                 darwin/win32: openAtLogin false) or setEnabled(true) does not restore it,
                 login-item.spec fails
       contract: if isLoginLaunch is not true for argv containing '--login-launch' (win32,
                 linux) and for darwin { wasOpenedAtLogin: true }, and false for a plain argv,
                 login-item.spec fails
       contract: if an execPath containing a space or a double quote yields an Exec line that
                 desktop-entry quoting would split or break, login-item.spec fails

  t-6  Add window controller with external-link policy
       files:    src/desktop/window.ts, src/desktop/window.spec.ts
       desc:     createWindowController({ createWindow, openExternal, origin, isQuitting })
                 → { show(), hasWindow() }. show() creates the window if none (or destroyed),
                 else restores/shows/focuses. 'close' while !isQuitting() → preventDefault + hide.
                 setWindowOpenHandler → openExternal for http(s) URLs, always { action: 'deny' };
                 will-navigate to a non-origin URL → preventDefault + openExternal.
       covers:   c-5, c-7, c-9
       contract: if a 'close' event while not quitting is not preventDefault-ed and the window
                 hidden, window.spec fails; if a 'close' while quitting IS preventDefault-ed
                 (quit would hang), window.spec fails
       contract: if show() after the window was destroyed does not construct exactly one new
                 window, or show() on a hidden window constructs a second one instead of
                 calling show + focus, window.spec fails
       contract: if the window-open handler returns anything but { action: 'deny' } for
                 'https://www.amazon.co.uk/dp/X' or 'https://ntfy.sh/t', or does not call
                 openExternal with that exact URL, window.spec fails
       contract: if openExternal is called for 'file:///etc/passwd' or 'javascript:alert(1)',
                 window.spec fails
       contract: if will-navigate to 'https://evil.example/' is not prevented, or will-navigate
                 to '<origin>/watches/x' is prevented, window.spec fails
       contract: if the BrowserWindow options set nodeIntegration true, contextIsolation false or
                 sandbox false, window.spec fails

  t-7  Add tray menu: Open, Start at login, Quit
       files:    src/desktop/tray.ts, src/desktop/tray.spec.ts
       desc:     trayMenuTemplate({ open, quit, loginItem }) → MenuItemConstructorOptions-shaped
                 array; createTray({ Tray, Menu, icon, ... }) builds it and rebuilds after a
                 toggle so the checkbox reflects isEnabled().
       covers:   c-5, c-6, c-9
       contract: if the template's labels are not exactly ['Open', 'Start at login', 'Quit'] in
                 order (separator allowed), tray.spec fails
       contract: if clicking 'Open' does not call open() once, or clicking 'Quit' does not call
                 quit() once, tray.spec fails
       contract: if 'Start at login' is not type 'checkbox' with checked === loginItem.isEnabled(),
                 or clicking it does not call setEnabled(!current) and rebuild the menu with the
                 new checked state, tray.spec fails

Wave 2 (depends t-1, t-2, t-3, t-4, t-5, t-6, t-7)
  t-8  Wire desktop app lifecycle and Electron entry
       files:    src/desktop/app.ts, src/desktop/app.spec.ts, src/desktop/main.ts
       desc:     runDesktop(deps) in order: userData override (PRICE_CHECK_USER_DATA, unpackaged
                 only) → requestSingleInstanceLock (false → app.quit, return) → await ready →
                 key + env into process.env → chdir(appPath) → import handler → startDesktopServer
                 → takeRuntime → powerMonitor 'resume' → runtime.tick → tray → registerOnFirstLaunch
                 → window unless login launch. 'second-instance' and macOS 'activate' → show();
                 'window-all-closed' listener that never quits; 'before-quit' → preventDefault,
                 quit sequence once, app.exit(0). main.ts passes the real electron modules.
       covers:   c-1, c-5, c-6, c-7, c-8, c-9
       contract: if, with requestSingleInstanceLock returning false, importHandler or
                 startDesktopServer is called, or app.quit is not, app.spec fails
       contract: if PRICE_CHECK_USER_DATA is honoured when isPackaged is true, or setPath('userData')
                 is recorded after requestSingleInstanceLock in the call-order log (the lock is
                 keyed by userData), app.spec fails
       contract: if process.env does not hold desktopServerEnv's values at the moment
                 importHandler is called (snapshot taken inside the fake), or chdir(appPath)
                 has not happened by then, app.spec fails
       contract: if a fake powerMonitor 'resume' emit does not call runtime.tick exactly once
                 per emit, app.spec fails
       contract: if a login launch constructs any BrowserWindow, or a normal launch constructs
                 none, app.spec fails; the tray is created in both
       contract: if 'second-instance' with no window (closed earlier) does not construct one,
                 or with a hidden window does not show it, app.spec fails
       contract: if no 'window-all-closed' listener is registered (Electron's default would quit
                 on Windows/Linux when the window closes), app.spec fails
       contract: if the quit sequence order is not ['scheduler-stopped', 'server-closed',
                 'db-closed', 'exit(0)'], runs twice on a second before-quit, or calls exit
                 before closeDb resolves, app.spec fails
       contract: if a rejecting closeDb leaves the process un-exited (exit not called),
                 app.spec fails — quit must end the process whatever shutdown throws

Wave 3 (depends t-8)
  t-9  Add Electron e2e harness and desktop config
       files:    e2e/desktop/launch.ts, e2e/desktop/harness.e2e.ts, playwright.desktop.config.ts,
                 playwright.config.ts, src/lib/server/scheduler.spec.ts
       desc:     launchDesktop({ userData, cwd, args, env, scheduler }) wraps
                 _electron.launch({ args: [REPO_ROOT, ...] }) with an allowlist env (PATH,
                 SystemRoot, HOME, DISPLAY, XDG_CONFIG_HOME→temp, PRICE_CHECK_USER_DATA,
                 SCHEDULER_DISABLED=1 unless scheduler: 'unsupported-only'); '--no-sandbox' only
                 on linux CI. spawnSecondInstance() spawns the electron binary directly. The
                 desktop config has workers 1, no webServer, testDir e2e/desktop; the main config
                 testIgnores e2e/desktop/**.
       covers:   c-1, c-5, c-8
       contract: if launchDesktop with scheduler: 'unsupported-only' starts Electron while the
                 userData DB holds a watch whose canonicalUrl defaultRegistry.identify() does not
                 report 'unsupported' (an amazon.co.uk URL), harness.e2e fails — it must throw
                 before launch (r-01)
       contract: if, with the test process exporting DATABASE_URL=file:/elsewhere.db,
                 ALERTS_ENCRYPTION_KEY and ORIGIN, the launched main's process.env (read via
                 electronApp.evaluate) has SCHEDULER_DISABLED other than '1' (default launch),
                 a DATABASE_URL outside the temp userData, the parent's key, or any ORIGIN,
                 harness.e2e fails
       contract: if Electron's process.versions.node major (electronApp.evaluate) differs from
                 .node-version's major, harness.e2e fails
       contract: if playwright.config.ts would collect e2e/desktop/*.e2e.ts (config.testIgnore
                 check), or playwright.desktop.config.ts has a webServer or workers ≠ 1,
                 scheduler.spec's 'wiring' block fails (vitest-gated)

Wave 4 (depends t-9)
  t-10 Prove first launch, key reuse, quit, relaunch
       files:    e2e/desktop/lifecycle.e2e.ts
       desc:     Real Electron on an empty temp userData, cwd a temp dir holding a poisoned .env
                 (DATABASE_URL=file:/nonexistent/x.db). Saves an ntfy channel on a .invalid
                 host through the window's form (r-01), quits, relaunches immediately.
       covers:   c-1, c-2, c-9
       contract: if the first window's URL is not http://127.0.0.1:<port>/ showing 'Nothing on
                 your watchlist yet.' within 30s, with no env vars set and the poisoned .env in
                 cwd, lifecycle.e2e fails; userData must then contain price-check.db and
                 alerts.key (and no DB at the .env path)
       contract: if alerts.key's sha256 differs between the first launch and the relaunch,
                 lifecycle.e2e fails
       contract: if, after relaunch, /account/alerts does not show the saved topic, or its ?/test
                 action reports the save-first or could-not-be-decrypted message instead of
                 'Not delivered' (a send attempt that failed on the .invalid host), lifecycle.e2e
                 fails
       contract: if app.quit() (electronApp.evaluate) leaves the Electron process alive after
                 10s, or it exits non-zero, lifecycle.e2e fails
       contract: if the relaunch started immediately after exit (no sleep; Windows CI included)
                 fails to open the DB, logs 'database is locked', or loses the channel or a
                 watch inserted before the first quit, lifecycle.e2e fails

  t-11 Prove CSRF and Host guard in Electron
       files:    e2e/desktop/origin-host.e2e.ts
       desc:     Real Electron with the real built handler. POSTs from inside the window via the
                 page's forms; foreign requests via raw node:http to the window's port.
       covers:   c-3, c-4
       contract: if submitting the /account/alerts ntfy save form in the app window (.invalid
                 topic) gets 403 or does not show the saved topic, origin-host.e2e fails
       contract: if ?/add from the window's origin with an unsupported URL is 403 instead of 400,
                 origin-host.e2e fails (no live fetch, r-01)
       contract: if a raw POST to /?/add with Origin https://evil.example, Origin
                 https://127.0.0.1:<port> (wrong scheme), Origin 'null' or no Origin gets anything
                 but 403, origin-host.e2e fails
       contract: if a GET with Host evil.example to a real file under build/client/_app/immutable/
                 (read from disk), /health or / gets anything but 403, origin-host.e2e fails;
                 control: the same asset with Host 127.0.0.1:<port> is 200 with an immutable
                 cache-control
       contract: if a TCP connect to the window's port on a non-loopback IPv4 of this machine
                 (os.networkInterfaces) succeeds, origin-host.e2e fails (test.skip when the host
                 has none)

  t-12 Prove tray-close, single instance, resume, login launch
       files:    e2e/desktop/background.e2e.ts
       desc:     Real Electron. Scheduler-enabled runs seed only unsupported-URL watches
                 (https://shop.e2e.invalid/…) so a pass records check failures with no network.
       covers:   c-5, c-6, c-7, c-8
       contract: if closing the window (BrowserWindow.close via evaluate) ends the process, or
                 GET /health on the saved origin is not 200 two seconds later, background.e2e
                 fails
       contract: if, with the window closed, aging both watches' last_checked_at by 2 days (a
                 separate client on the userData DB, then closed) and emitting powerMonitor
                 'resume' does not add a new failure row to each /watches/<id> within 10s,
                 background.e2e fails — covers "checks keep running" and resume catch-up
       contract: if a second instance spawned on the same userData does not exit 0 within 15s,
                 or prints the server-listening line, background.e2e fails; afterwards the first
                 app must have exactly one visible window, also when its window was closed first
       contract: if a launch with '--login-launch' has any BrowserWindow once the server answers
                 /health, background.e2e fails
       contract: if an unpackaged launch leaves openAtLogin true (darwin/win32,
                 getLoginItemSettings) or a file under <XDG_CONFIG_HOME>/autostart (linux),
                 background.e2e fails

  t-13 Run desktop e2e headless in three-OS CI
       files:    .github/workflows/ci.yml, scripts/ci-desktop.spec.ts
       desc:     Executor first reads ~/.claude/memory/reference_ci_supply_chain_hardening.md and
                 reference_ci_pipeline_optimisation.md and audits ci.yml against them. Test job:
                 after e2e, `pnpm desktop:build` then `pnpm test:desktop`, wrapped in
                 `xvfb-run -a` on Linux only; electron binary cache keyed on pnpm-lock.yaml;
                 desktop reports in the failure upload. No new actions unless SHA-pinned.
       covers:   c-1, c-2, c-3, c-4, c-5, c-6, c-7, c-8, c-9
       contract: if the test job's matrix loses linux, macos or windows, or the desktop step does
                 not run `pnpm test:desktop` after `pnpm desktop:build`, ci-desktop.spec fails
       contract: if the Linux desktop run is not under xvfb-run, or the macOS/Windows runs are,
                 ci-desktop.spec fails
       contract: if any new uses: is not SHA-pinned or permissions widen beyond contents: read,
                 pnpm ci:policy and workflow-policy.spec fail
```

## Coverage

| Criterion | Tasks |
|---|---|
| c-1 first launch, no setup | t-1, t-2, t-8, t-9, t-10, t-13 |
| c-2 key once, credentials survive relaunch | t-2, t-10, t-13 |
| c-3 same-origin POST ok, foreign Origin 403 | t-2, t-3, t-11, t-13 |
| c-4 127.0.0.1 only, Host 403 incl. /_app/immutable | t-3, t-11, t-13 |
| c-5 close → tray, server + checks keep running | t-6, t-7, t-8, t-9, t-12, t-13 |
| c-6 start-at-login, tray-only login launch, toggle | t-5, t-7, t-8, t-12, t-13 |
| c-7 single instance reopens window | t-6, t-8, t-12, t-13 |
| c-8 resume → immediate catch-up pass | t-4, t-8, t-9, t-12, t-13 |
| c-9 quit ends process, relaunch keeps data | t-4, t-6, t-7, t-8, t-10, t-13 |

9/9 covered. Every criterion has at least one vitest-gated contract (gates each commit) and
at least one real-Electron e2e contract (CI on three OSes).

## Judgment calls

- Compile the main process with `tsc -p tsconfig.desktop.json` → `build-desktop/`; rejected esbuild/rolldown bundling (new direct dep or config) and Electron's own type stripping (unverified in Electron's embedded Node, and `#lib` / `.ts` specifiers break) — tsc is already a dependency and t-1's import scan makes the one rule it needs (relative `.ts` imports only) testable.
- Main-process code in `src/desktop/` with locally declared structural interfaces; rejected a root `electron/` dir (needs vitest/tsconfig/eslint include changes) and `import type` from electron (would pin all wave-1 tasks behind t-1's install).
- "Treat as plain http" = `PROTOCOL_HEADER=x-forwarded-proto` + the wrapper overwriting that header with `http`; rejected rebuilding with a fixed ORIGIN (locked out) and constructing Request objects ourselves (re-implements adapter-node's getRequest).
- Kit bundle → main via a `Symbol.for` globalThis slot filled by `hooks.server.ts init`; rejected having main import `src/lib/server/scheduler.ts`/`db` directly — a second module graph means a second libsql client on the same file, which the Windows lock finding forbids.
- Scheduler-enabled e2e (c-5/c-8) with only unsupported-URL watches plus a pre-launch guard that refuses any adapter-claimed URL; rejected a test-only fake-shop env switch in production code, and rejected unit-only proof of c-8 (the resume → real tick → recorded check path would then never run end-to-end).
- Resume catch-up observed by aging `last_checked_at` from a second client while the app runs; rejected waiting out CHECK_INTERVAL_HOURS (minimum 1h) and injecting a fake clock into the built server.
- c-6 registration proven by unit fakes per platform plus an e2e that unpackaged runs never register; rejected packaging in this phase to test real login items (deferred to 05, and the locked decision forbids unpackaged registration anyway). macOS login-launch detection via `wasOpenedAtLogin` is unit-only and a known risk on macOS 13+ (SMAppService).
- userData redirect via `PRICE_CHECK_USER_DATA`, honoured only when `!app.isPackaged`, applied before `requestSingleInstanceLock`; rejected Chromium's `--user-data-dir` switch (undocumented interaction with Electron's userData and the lock).
- First-launch marker is its own file, not "alerts.key was absent"; rejected coupling login registration to key creation, since a restored key file would then block registration and vice versa.
- `--no-sandbox` only when linux + CI inside the e2e harness (Ubuntu 24.04 AppArmor blocks the unprivileged-userns sandbox); rejected setting it in main.ts, which would ship unsandboxed.
- Separate `playwright.desktop.config.ts` and `pnpm test:desktop`; rejected adding a project to the existing config, whose global webServer seeds + builds + previews for every run and whose seeded DB the desktop runs must not share.
- New gitleaks contract enumerates every `.dross/phases/<id>/` dir, not just a 03 row; rejected a one-off entry check because 04 and 05 would repeat the miss.
- E2E specs (t-9–t-12) aren't in the per-commit vitest gate, so each of those tasks keeps a vitest-gated contract where one fits (t-9's config checks in scheduler.spec), and its executor must observe `pnpm desktop:build && pnpm test:desktop` green locally before committing.
