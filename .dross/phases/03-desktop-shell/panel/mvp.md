# 03-desktop-shell: MVP lens draft

```
Phase 03-desktop-shell: 6 tasks across 3 waves

Wave 1
  t-1  Expose scheduler control across the bundle boundary
       files:    src/lib/server/scheduler.ts, src/lib/server/scheduler.spec.ts,
                 src/lib/server/desktop-bridge.ts, src/lib/server/desktop-bridge.spec.ts,
                 src/hooks.server.ts, src/hooks.server.spec.ts
       desc:     startScheduler returns { tick, stop } | null instead of a bare stop fn. hooks init
                 publishes that value through new desktop-bridge.ts (publishScheduler / publishedScheduler,
                 stored at globalThis[Symbol.for('price-check.scheduler')], no $app imports), so the
                 esbuild-bundled Electron main can reach the scheduler that lives inside build/handler.js.
       covers:   c-8, c-9
       contract: if startScheduler's returned tick() does not start a pass that calls due(), or stop()
                 leaves the interval firing (fake timers advanced 3x tickMs after stop: due() called only
                 by the initial tick), scheduler.spec fails
       contract: if startScheduler with SCHEDULER_DISABLED='1', VITEST set or building does not return null,
                 scheduler.spec fails (r-01: no live check from any test run)
       contract: if hooks init (startScheduler mocked to return a fake control) does not leave
                 publishedScheduler() === that fake, or publishes before migrateDb resolves, hooks.server.spec
                 fails; init order must stay ['key', 'migrated', 'scheduler']
       contract: if a second copy of desktop-bridge.ts (vi.resetModules + re-import) does not see the control
                 the first copy published (i.e. it is module state, not the Symbol.for global), or
                 publishedScheduler() is not null before any publish, desktop-bridge.spec fails

  t-2  Add loopback server wrapper and alerts key
       files:    src/desktop/server.ts, src/desktop/server.spec.ts,
                 src/desktop/user-data.ts, src/desktop/user-data.spec.ts
       desc:     createDesktopServer(handler) listens on 127.0.0.1:0, answers a non-loopback Host
                 (isLoopbackHost from local-request.ts) with a text 403 before the handler, otherwise
                 overwrites x-forwarded-proto to 'http' and calls handler(req, res, next404); returns
                 { port, close() }. ensureAlertsKey(dir) reads <dir>/alerts.key or creates it once (32
                 random bytes, base64, flag 'wx', mode 0o600); never overwrites; a bad file throws naming
                 the path, never the value. desktopEnv(dir, key) -> { DATABASE_URL: file:<dir>/price-check.db,
                 ALERTS_ENCRYPTION_KEY, PROTOCOL_HEADER: 'x-forwarded-proto' }.
       covers:   c-1, c-2, c-3, c-4
       contract: if a request with Host 'evil.example' to '/_app/immutable/entry/app.js', '/' or '/health'
                 reaches the stub handler or gets anything but 403, server.spec fails
       contract: if a loopback request that sent 'x-forwarded-proto: https' reaches the handler with
                 req.headers['x-forwarded-proto'] !== 'http', server.spec fails (adapter-node would then
                 build an https origin and Kit's CSRF check would 403 every same-origin POST)
       contract: if server.address().address !== '127.0.0.1', the port is 0 or equal across two
                 concurrent createDesktopServer calls (a fixed port), or a connect still succeeds after
                 close() resolves, server.spec fails
       contract: if ensureAlertsKey on an empty dir does not write a key parseAlertsKey accepts, or on POSIX
                 (statSync(file).mode & 0o777) !== 0o600, user-data.spec fails
       contract: if a second ensureAlertsKey returns a different key or changes the file's sha256, or a
                 truncated/garbage alerts.key is rewritten instead of throwing (bytes unchanged afterwards,
                 message names the path and contains no base64 of the file), user-data.spec fails
       contract: if desktopEnv's DATABASE_URL is not 'file:' + join(dir, 'price-check.db') or PROTOCOL_HEADER
                 is not 'x-forwarded-proto', user-data.spec fails

  t-3  Add start-at-login registration module
       files:    src/desktop/login.ts, src/desktop/login.spec.ts
       desc:     createLoginItems(deps: platform, isPackaged, get/setLoginItemSettings, fs, env, homedir,
                 execPath, userDataDir) -> { registerOnFirstLaunch, isLoginLaunch(argv), isEnabled,
                 setEnabled }. darwin/win32 use setLoginItemSettings (win32 args ['--login']); linux writes
                 <XDG_CONFIG_HOME|~/.config>/autostart/price-check.desktop with Exec="<APPIMAGE|execPath>" --login.
                 A <userData>/login-registered marker, written only after a real registration, makes it once-only.
       covers:   c-6
       contract: if registerOnFirstLaunch with isPackaged=false calls setLoginItemSettings or writes any
                 autostart file or marker, login.spec fails (dev/test runs never register)
       contract: if a packaged first launch on darwin or win32 does not call setLoginItemSettings exactly once
                 with openAtLogin: true (win32 args ['--login']) and write the marker, or a later launch with
                 the marker present calls it again (also after setEnabled(false)), login.spec fails
       contract: if on linux the autostart file is not at <XDG_CONFIG_HOME>/autostart/price-check.desktop
                 (falling back to <home>/.config) with Exec="<APPIMAGE when set, else execPath>" --login,
                 setEnabled(false) does not delete it, or setEnabled(true) does not recreate it, login.spec fails
       contract: if isLoginLaunch is false for argv containing '--login' (win32/linux) or for
                 getLoginItemSettings().wasOpenedAtLogin === true (darwin), or true for a plain launch,
                 login.spec fails; isEnabled must follow the OS state (openAtLogin / file present), not the marker

  t-4  Add desktop lifecycle: window, tray, quit
       files:    src/desktop/lifecycle.ts, src/desktop/lifecycle.spec.ts
       desc:     startDesktop(deps) with every Electron API injected through narrow local interfaces (app,
                 BrowserWindow factory, Tray/Menu, powerMonitor, shell, login items, scheduler(),
                 startServer()). Order: single-instance lock -> startServer -> registerOnFirstLaunch -> tray ->
                 window unless login launch. Close hides; second-instance / dock activate / tray Open show or
                 recreate; resume -> scheduler()?.tick(); before-quit -> stop scheduler, await server.close(),
                 app.exit(0). Window denies new windows and foreign navigation, opening them via shell.openExternal.
       covers:   c-1, c-5, c-6, c-7, c-8, c-9
       contract: if requestSingleInstanceLock() returns false and startServer is called at all, or app.exit(0)
                 is not called, lifecycle.spec fails (c-7: no second process keeps running, no second server)
       contract: if a 'second-instance' event with the window hidden does not show + focus it, or with the
                 window destroyed does not create exactly one new window on the same http://127.0.0.1:<port>/,
                 lifecycle.spec fails
       contract: if a non-login launch does not create one window with loadURL('http://127.0.0.1:<port>/')
                 using the port startServer resolved, lifecycle.spec fails (c-1)
       contract: if the window 'close' event while not quitting is not preventDefault-ed and hidden, or it
                 calls server.close, scheduler stop or app.quit/exit, or no 'window-all-closed' listener is
                 registered (Electron's default would quit), lifecycle.spec fails; tray 'Open' must show the
                 hidden window and macOS 'activate' must show it (c-5)
       contract: if a login launch (isLoginLaunch true) creates a window or no tray, registerOnFirstLaunch
                 is not called once per startup, or clicking the tray 'Start at login' checkbox does not call
                 setEnabled(item.checked), lifecycle.spec fails (c-6)
       contract: if a powerMonitor 'resume' does not call the published scheduler's tick() exactly once, or
                 throws when scheduler() returns null (SCHEDULER_DISABLED), lifecycle.spec fails (c-8)
       contract: if tray 'Quit' or app 'before-quit' does not run scheduler stop, then awaited server.close(),
                 then app.exit(0) in that order (recorded call log), or a window 'close' during quit is still
                 prevented, lifecycle.spec fails (c-9)
       contract: if setWindowOpenHandler for 'https://www.amazon.co.uk/dp/B0X' returns anything but
                 { action: 'deny' } or skips shell.openExternal with that URL, or 'will-navigate' to a foreign
                 origin is not preventDefault-ed + opened externally while a same-origin navigation is allowed,
                 lifecycle.spec fails (decision external_links)

Wave 2 (depends t-1, t-2, t-3, t-4)
  t-5  Wire Electron entry, dependency and build
       files:    src/desktop/main.ts, scripts/build-desktop.ts, scripts/build-desktop.spec.ts,
                 package.json, pnpm-workspace.yaml, pnpm-lock.yaml
       desc:     electron (exact pin) and esbuild as direct devDependencies; onlyBuiltDependencies gains electron
                 (its postinstall downloads the binary); "main": "build/desktop/main.js"; "build": "vite build &&
                 node scripts/build-desktop.ts"; "desktop": "pnpm build && electron .". build-desktop.ts bundles
                 src/desktop/main.ts with esbuild (platform node, format esm, external electron and ../handler.js).
                 main.ts: PRICE_CHECK_USER_DATA -> app.setPath('userData') only when !app.isPackaged, before the
                 lock; startServer = ensureAlertsKey -> Object.assign(process.env, desktopEnv(...)) (overriding
                 inherited values) -> dynamic import of build/handler.js -> createDesktopServer; passes real
                 electron APIs, createLoginItems and publishedScheduler into startDesktop. Run pnpm check too.
       covers:   c-1
       contract: if build-desktop's esbuild options do not list 'electron' as external, outfile !== package.json
                 "main", or the entry is not src/desktop/main.ts, build-desktop.spec fails
       contract: if the bundle (built by build-desktop.spec into a temp dir) contains a static import of
                 handler.js (the server would init before DATABASE_URL / ALERTS_ENCRYPTION_KEY are set), any
                 '$app/' import, or inlines electron instead of importing it, build-desktop.spec fails
       contract: if pnpm-workspace.yaml onlyBuiltDependencies is not exactly ['electron', 'esbuild'], or the
                 electron devDependency is not an exact version (no ^ or ~), build-desktop.spec fails

Wave 3 (depends t-5)
  t-6  Prove the real app end-to-end; CI and gitleaks
       files:    e2e/electron-app.ts, e2e/desktop.e2e.ts, .github/workflows/ci.yml,
                 .gitleaks.toml, scripts/gitleaks-config.spec.ts
       desc:     EXECUTOR: read ~/.claude/memory/reference_ci_supply_chain_hardening.md first and audit ci.yml
                 against it; report findings. electron-app.ts: launchDesktop({ userData, args }) via Playwright
                 _electron on build/desktop/main.js (fails fast if missing), env from an allowlist (PATH, HOME,
                 SystemRoot, TEMP/TMP, USERPROFILE, APPDATA, LOCALAPPDATA, DISPLAY, XAUTHORITY, XDG_RUNTIME_DIR)
                 plus PRICE_CHECK_USER_DATA and SCHEDULER_DISABLED=1, never a process.env spread; --no-sandbox only
                 on Linux CI; a raw node:http request helper (setHost off). ci.yml: the Linux e2e step runs under
                 `xvfb-run -a`. .gitleaks.toml: dross-verify entry gains ^\.dross/phases/03-desktop-shell/tests\.json$.
       covers:   c-1, c-2, c-3, c-4, c-5, c-7, c-9
       contract: if a launch on an empty temp userData with no ALERTS_ENCRYPTION_KEY/DATABASE_URL does not open a
                 window at http://127.0.0.1:<port>/ showing h1 'Watchlist' and 'Nothing on your watchlist yet.',
                 or userData then lacks alerts.key or price-check.db, desktop.e2e 'first launch' fails (c-1)
       contract: if launchDesktop's env contains any key outside the allowlist, or lacks SCHEDULER_DISABLED=1,
                 desktop.e2e 'launch env' fails (r-01: the app under test never re-checks a watch)
       contract: if saving an ntfy channel through the form in the app window does not show the saved channel,
                 or a raw POST to /account/alerts?/save with Origin http://evil.example and a loopback Host is not
                 403, desktop.e2e 'csrf' fails (c-3)
       contract: if a raw request with Host 'evil.example' to a real file under /_app/immutable/ (name read from
                 build/client/_app/immutable) or to '/' is not 403 while the same path with Host
                 127.0.0.1:<port> is 200, desktop.e2e 'host guard' fails (c-4)
       contract: if after BrowserWindow.close() the process has exited or /health stops answering 200, or a second
                 electron process on the same userData does not exit with code 0 within 15s while the first app's
                 single window becomes visible again (BrowserWindow.getAllWindows().length === 1), desktop.e2e
                 'background + single instance' fails (c-5, c-7)
       contract: if after app.quit() the Electron process has not exited within 10s, or an immediate relaunch on
                 the same userData (run on linux, macos and windows in CI) does not show the saved ntfy topic as
                 readable (not flagged undecryptable) with alerts.key's sha256 unchanged, desktop.e2e
                 'quit + relaunch' fails (c-2, c-9)
       contract: if the Linux e2e step is not wrapped in xvfb-run, test (linux) fails at electron launch (no
                 display); if the edit adds an unpinned action or widens permissions, pnpm ci:policy fails
       contract: if the dross-verify allowlist entry's paths lack '^\.dross/phases/03-desktop-shell/tests\.json$',
                 the new assertion in gitleaks-config.spec fails
```

## Coverage

| Criterion | Tasks |
|---|---|
| c-1 empty userData, no env, window on empty watchlist | t-2 (desktopEnv, key on first launch), t-4 (window on startServer's port), t-5 (main overrides inherited env), t-6 (real first launch) |
| c-2 key generated once; credentials decrypt after relaunch | t-2 (create-once, never regenerate), t-6 (saved channel readable after relaunch, key hash unchanged) |
| c-3 same-origin POST ok, foreign Origin 403 | t-2 (x-forwarded-proto forced to http), t-6 (real form POST + forged Origin) |
| c-4 127.0.0.1 only; foreign Host 403 incl. /_app/immutable | t-2 (bind address, Host check before handler), t-6 (real immutable asset) |
| c-5 close -> tray; server + scheduler keep running; tray Open | t-4 (hide-on-close, tray Open, no quit), t-6 (process + /health survive close) |
| c-6 login registration once; login launch tray-only; toggle | t-3 (registration, marker, Linux XDG, toggle), t-4 (login launch tray-only, tray checkbox) |
| c-7 single instance; running app shows/reopens window | t-4 (lock denied -> no server; second-instance show/recreate), t-6 (real second process) |
| c-8 resume -> immediate pass over due watches | t-1 (tick reachable from main), t-4 (resume -> tick) |
| c-9 quit stops server + scheduler, ends process; relaunch same DB | t-1 (stop exposed), t-4 (ordered shutdown + exit), t-6 (process exits; relaunch on 3 OSes) |

9/9 criteria covered. The `.dross/phases/03-desktop-shell/tests.json` gitleaks entry rides in t-6.

## Judgment calls

- TS main via an esbuild bundle (`scripts/build-desktop.ts` -> `build/desktop/main.js`, chained into `pnpm build`), not Electron's Node type stripping: esbuild resolves `#lib/*` and `.ts` imports, and which Electron versions strip types is unverified. Chaining into `pnpm build` means the existing Playwright webServer build already produces the bundle, so no new CI step.
- Main loads adapter-node's `build/handler.js` (dynamic import after setting env) and wraps it; it does not run `build/index.js` as a child process. Locked decision desktop_server_wrapper puts the server in main, and one process is what makes c-7/c-9 hold.
- "Treat as plain http" = main sets `PROTOCOL_HEADER=x-forwarded-proto` and the wrapper overwrites that header to `http` on every request. Rejected: setting ORIGIN (adapter-node 6 bakes it at build) and patching the build output.
- Scheduler reached through a `Symbol.for` global slot (`desktop-bridge.ts`), because main and the server are separate bundles with separate module state. Rejected: an internal HTTP tick endpoint (new attack surface) and starting a second scheduler in main (it would need `$app` env).
- Alerts key lives in its own `alerts.key` file (locked); the first-launch login marker is a separate `login-registered` file written only after a real (packaged) registration. Rejected: using "key file was just created" as the first-launch signal, because a dev run that creates the key first would then block registration for the packaged app forever.
- Login launch is detected by a `--login` arg on Windows/Linux and `wasOpenedAtLogin` on macOS. No hidden-window heuristics.
- lifecycle.ts uses its own narrow structural interfaces instead of importing electron types. That keeps t-3/t-4 in wave 1, parallel with the dependency install. A mismatch shows up as a type error in t-5, which runs `pnpm check`.
- I merged the server wrapper with the alerts-key/env module (t-2) and the entry with the dependency/build plumbing (t-5). Each of those halves alone is a single small file with no criterion it can prove.
- One task (t-6) holds all real-Electron e2e plus the CI and gitleaks edits. I did not split per criterion: every scenario shares one launch helper and one build, and the CI change is a single `xvfb-run` line.
- c-6 (login item) and c-8 (resume) are unit-only. An e2e cannot register a login item for an unpackaged binary (the locked decision forbids it) or fake an OS sleep. Asserting the tray-only login launch end-to-end would need a port-discovery channel that exists only for tests, and this lens rejects that.
- c-2 "send" after relaunch is proven by decrypt-after-relaunch in e2e plus the existing alerts.spec send path. ntfy accepts only https topics, so a local fake server would need TLS scaffolding. Rejected as speculative.
- Linux CI sandbox: `--no-sandbox` is passed by the e2e helper only on Linux CI (ubuntu-24.04 AppArmor blocks Electron's userns sandbox). Rejected: a `sudo sysctl` step in the workflow, which adds a privileged step to the hardened workflow. Sandbox config for shipped builds is 05's packaging work.
- Not included: `ELECTRON_SKIP_BINARY_DOWNLOAD` on the static CI job, tray icons beyond a placeholder, Windows AppUserModelID (deferred to 04), and asar/native libsql packaging (deferred to 05). None of these is traceable to a criterion.
