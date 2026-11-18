# 05-release — verification lens draft

Method: for each criterion I wrote the test that would prove it first. Then I picked the
smallest task that makes that test runnable. Three kinds of proof show up:
(a) vitest unit/static specs, which gate every commit;
(b) Playwright e2e that the executor runs locally on macOS before committing;
(c) PR-CI-only runs (Windows/Linux packaged and update e2e). The macOS dev host cannot run (c).
Each contract below says which kind it is.

```
Phase 05-release — 16 tasks across 6 waves

Wave 1
  t-1  Add packaging deps and phase gitleaks entry
       files:    .gitleaks.toml, package.json, pnpm-lock.yaml, pnpm-workspace.yaml,
                 scripts/build-desktop.spec.ts
       covers:   c-1, c-2, c-5
       desc:     Only wave-1 task (vitest is red until the gitleaks entry lands). tests.json
                 allowlist gains ^\.dross/phases/05-release/tests\.json$. devDependencies +=
                 electron-builder (exact x.y.z); dependencies += electron-updater (exact; it
                 stays external to the main bundle, so it must ship in node_modules).
                 pnpm-workspace.yaml gains supportedArchitectures (os current, cpu x64+arm64,
                 libc current); onlyBuiltDependencies unchanged. pnpm-lock.yaml regenerated.
       contract: - if .gitleaks.toml lacks the exact anchored 05-release tests.json path,
                   gitleaks-config.spec 'every phase allowlisted' fails (red today)
                 - if electron-builder is not an exact x.y.z devDependency, or electron-updater
                   is not an exact x.y.z in `dependencies` (a devDependency is left out of the
                   packaged node_modules and the packaged app dies at import), build-desktop.spec
                   'packaging toolchain' fails
                 - if pnpm-workspace.yaml supportedArchitectures.cpu lacks x64 or arm64, or
                   onlyBuiltDependencies stops being exactly [electron, esbuild],
                   build-desktop.spec fails
                 - on a darwin host, if @libsql/darwin-arm64/package.json or
                   @libsql/darwin-x64/package.json cannot be resolved from libsql's own
                   directory, build-desktop.spec 'both darwin libsql binaries installed' fails
                   (the universal app would ship one arch); skipped off darwin
       depends:  —

Wave 2 (all depend t-1)
  t-2  Add electron-builder config and package script
       files:    scripts/package-desktop.ts, scripts/package-desktop.spec.ts, package.json,
                 .gitignore
       covers:   c-1, c-2, c-3, c-4, c-5
       desc:     builderConfig({version, feedUrl?, sign}) returns the electron-builder
                 Configuration object. packageDesktop() runs electron-builder's build() for the
                 host OS with publish 'never'. CLI: node scripts/package-desktop.ts --version <v>
                 [--feed-url <loopback url>] [--sign] [--out <dir>]; script package:desktop.
                 Exports PRODUCT_NAME and artifactName patterns. appId is imported from APP_ID.
                 mac universal dmg+zip, x64ArchFiles over both @libsql/darwin-*. win nsis x64
                 oneClick per-user. linux AppImage x64. asar with libsql, @libsql/* and drizzle/**
                 unpacked. npmRebuild false. detectUpdateChannel false. /dist gitignored.
                 Executor observes `pnpm package:desktop --version 0.1.4` produce
                 dist/mac-universal/<PRODUCT_NAME>.app locally before committing.
       contract: - if builderConfig().appId !== APP_ID, or package-desktop.ts source contains
                   the literal 'io.github.rivil.price-check' (must be imported, decision
                   artefacts), package-desktop.spec fails
                 - if mac.target is not exactly dmg and zip each with arch ['universal'], or any
                   mac target names arm64 or x64, package-desktop.spec fails
                 - if mac.x64ArchFiles does not match both
                   .../app.asar.unpacked/node_modules/@libsql/darwin-x64/index.node and the
                   darwin-arm64 one, or does match a path under Contents/Frameworks (a pattern
                   that broad hides a missing lipo), package-desktop.spec fails
                 - if win.target is not exactly [{target:'nsis', arch:['x64']}], or
                   nsis.oneClick !== true, or nsis.perMachine !== false (a UAC prompt),
                   package-desktop.spec fails (c-3)
                 - if linux.target is not exactly [{target:'AppImage', arch:['x64']}] (deb, rpm or
                   snap is a milestone non-goal), or any linux executableArgs contains
                   '--no-sandbox', package-desktop.spec fails
                 - if asar !== true, or asarUnpack does not match node_modules/libsql/index.js,
                   node_modules/@libsql/linux-x64-gnu/index.node,
                   node_modules/@libsql/win32-x64-msvc/index.node and
                   drizzle/0000_little_dreaming_celestial.sql, or npmRebuild !== false,
                   package-desktop.spec fails
                 - if the files patterns (applied in order, negations included) leave out
                   dist-desktop/main.js, build/handler.js, src/desktop/assets/tray-iconTemplate.png
                   or drizzle/meta/_journal.json, or take in local.db, .env, src/desktop/main.ts,
                   e2e/desktop/launch.ts or test-results/x, package-desktop.spec fails
                 - if detectUpdateChannel !== false (an rc build would write rc*.yml instead of
                   latest*.yml, c-4), package-desktop.spec fails
                 - if no feedUrl does not give publish [{provider:'github', owner:'Rivil',
                   repo:'price-check'}], or feedUrl 'http://127.0.0.1:47811/' does not give
                   [{provider:'generic', url}], or 'https://example.com/' or 'http://10.0.0.1/'
                   does not throw (only a loopback test feed may be baked in, decision
                   update_flow), package-desktop.spec fails
                 - if extraMetadata.version is not the given version for '0.1.5' and
                   '0.1.5-rc.1', or '0.1', 'v0.1.5' or '' does not throw, package-desktop.spec
                   fails
                 - if sign:false does not give mac.identity === null, mac.notarize false and env
                   CSC_IDENTITY_AUTO_DISCOVERY === 'false', or sign:true does not give
                   mac.notarize === true, or win has any certificate*, signtool* or azureSign*
                   key in either mode, package-desktop.spec fails
                 - if .gitignore lacks /dist, or the package:desktop script is not
                   'node scripts/package-desktop.ts', package-desktop.spec fails
       depends:  t-1

  t-3  Add release tag gate and credential preflight
       files:    scripts/release-tag.ts, scripts/release-tag.spec.ts
       covers:   c-4
       desc:     checkReleaseTag({ref, packageVersion, onMain}) -> {ok, version, prerelease} or a
                 refusal reason. missingAppleCredentials(env) -> the names of the five unset or
                 blank secrets. CLI `tag` writes version= and prerelease= to $GITHUB_OUTPUT.
                 CLI `apple-credentials` exits 1 listing names only. Node built-ins only, so the
                 tag job runs no dependency code.
       contract: - if refs/tags/v0.1.5 with package 0.1.5 on main does not give
                   {version:'0.1.5', prerelease:false}, or v0.1.5-rc.1 does not give
                   {version:'0.1.5-rc.1', prerelease:true}, release-tag.spec fails
                 - if any of v0.1.6 (vs 0.1.5), v0.1.5 with onMain false, v0.1.5-beta.1,
                   v0.1.5-rc, v0.1.5-rc.0, v0.1.5-rc.01, v0.1.5.0, v0.1.5+b1, 0.1.5 (no v) or
                   refs/heads/v0.1.5 is accepted, release-tag.spec's refusal table fails
                 - if the CLI writes anything to $GITHUB_OUTPUT for a refused tag, or exits 0,
                   release-tag.spec fails (a later job must never read a half-set output)
                 - if missingAppleCredentials does not return exactly the unset/whitespace
                   names among CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY_P8_BASE64,
                   APPLE_API_KEY_ID, APPLE_API_ISSUER in that order, release-tag.spec fails
                 - if `apple-credentials` output (stdout+stderr captured) contains any of the
                   sentinel values set in the test env, or exits 0 with one missing,
                   release-tag.spec fails (secret handling: names only)
       depends:  t-1

  t-4  Run packaged server from app.asar.unpacked
       files:    src/desktop/app-paths.ts, src/desktop/app-paths.spec.ts, src/desktop/main.ts
       covers:   c-1
       desc:     serverCwdFor(appRoot) maps a root whose last segment is app.asar to its
                 app.asar.unpacked sibling (either separator) and leaves any other root as is.
                 main.ts passes serverCwdFor(APP_ROOT) to loadAdapterHandler, because
                 process.chdir cannot enter an asar archive and migrate.ts resolves drizzle/ from
                 the cwd (t-2 unpacks drizzle/**).
       contract: - if serverCwdFor('/A/Price Check.app/Contents/Resources/app.asar') is not
                   '.../app.asar.unpacked', or the Windows 'C:\...\resources\app.asar' and AppImage
                   '/tmp/.mount_x/resources/app.asar' rows are not mapped the same way,
                   app-paths.spec fails
                 - if '/repo', '/x/app.asar.unpacked' or '/x/app.asarx' are changed, app-paths.spec
                   fails (unpackaged dev and e2e must keep the repo root)
                 - if main.ts does not hand serverCwdFor's result to loadAdapterHandler, t-13's
                   packaged smoke first launch shows the startup error box, not the watchlist
                 - unpackaged: executor observes pnpm test:e2e:desktop first-run.e2e green
       depends:  t-1

  t-5  Add updater: checks, background download, notify once
       files:    src/desktop/updater.ts, src/desktop/updater.spec.ts
       covers:   c-5
       desc:     createUpdater({autoUpdater, appVersion, notifier, onReady, log}) over a
                 structural AutoUpdater type (electron/electron-updater as import type only).
                 Returns start(), stop(), status() and installOnExit('quit'|'restart').
                 UPDATE_CHECK_INTERVAL_MS = 6 h. publishUpdaterHandle({status, restart}) sets
                 Symbol.for('price-check.updater'), which the packaged e2e reads.
       contract: - if start() does not set autoDownload true, autoInstallOnAppQuit false (the
                   lifecycle installs after shutdown, c-6), allowDowngrade false, and
                   allowPrerelease true for '0.1.5-rc.1' and false for '0.1.5' (an rc takes the
                   final, a final never takes an rc), updater.spec fails
                 - if checkForUpdates is not called once at start, again at exactly 6 h (not at
                   6 h - 1 ms) and 4 times by 18 h (fake timers), or is called after stop(),
                   updater.spec fails
                 - if a rejecting checkForUpdates or an 'error' event throws, leaves an
                   unhandled rejection, or stops the next 6 h check, updater.spec fails
                 - if 'update-downloaded' {version:'0.1.6'} does not give exactly one notifier
                   show (body names 0.1.6 and 'Restart to update') and one onReady('0.1.6'), or a
                   re-emitted 0.1.6 shows again, or a later 0.1.7 does not show, updater.spec
                   fails
                 - if, after a download, 24 h of fake timers produce any quitAndInstall call (a
                   forced restart), updater.spec fails
                 - if installOnExit('quit') with nothing downloaded calls quitAndInstall, or
                   with a download does not call quitAndInstall(true, false) once, or
                   installOnExit('restart') does not call quitAndInstall(true, true), or a
                   throwing quitAndInstall propagates, updater.spec fails
                 - if status() is not 'idle' -> 'checking' -> 'downloaded' with version 0.1.6
                   across the events, or publishUpdaterHandle's symbol is not
                   Symbol.for('price-check.updater'), updater.spec fails
                 - if updater.ts (source ?raw) contains setFeedURL, a provider/url assignment,
                   or a value import of electron or electron-updater, updater.spec fails
                   (decision update_flow: no runtime feed override)
       depends:  t-1

  t-6  Install update after shutdown; tray restart item
       files:    src/desktop/lifecycle.ts, src/desktop/lifecycle.spec.ts, src/desktop/tray.ts,
                 src/desktop/tray.spec.ts
       covers:   c-5, c-6
       desc:     LifecycleDeps gains optional updates {installOnExit(mode)}. Absent means
                 unpackaged, nothing installs. LifecycleTrayActions/TrayActions gain
                 restartToUpdate(), which sets mode 'restart' and calls app.quit(). Shutdown runs
                 scheduler stop, server close and DB close, then installOnExit(mode), then
                 app.exit(0). TrayHandle gains setUpdateReady(bool), which adds a
                 'Restart to update' item above Quit. Executor also runs pnpm check.
       contract: - if Quit with updates present does not log exactly [stop, closeServer,
                   closeDb, install:quit, exit:0] in lifecycle.spec's call-order log, lifecycle.spec
                   fails (Quit installs; the installer starts only after the DB is closed, c-6)
                 - if restartToUpdate() does not log [..., closeDb, install:restart, exit:0], or
                   calls app.quit() other than once, or a second restartToUpdate while quitting
                   changes anything, lifecycle.spec fails
                 - if closeDb hangs and install runs before SHUTDOWN_DEADLINE_MS elapses (fake
                   timers), or is never called, lifecycle.spec fails
                 - if a throwing installOnExit stops app.exit(0), lifecycle.spec fails
                 - if any path calls app.relaunch() (the only relaunch is the installer's,
                   after this process exits), lifecycle.spec fails
                 - if deps without updates (unpackaged) changes the existing quit order or calls
                   any install, lifecycle.spec fails
                 - if the tray menu before setUpdateReady(true) is not exactly Open, Start at
                   login, separator, Quit, or after it lacks exactly one 'Restart to update' item
                   above Quit whose click calls restartToUpdate once, or a second
                   setUpdateReady(true) adds a second item, tray.spec fails
       depends:  t-1

  t-7  Extract shared workflow line reader
       files:    scripts/workflow-reader.ts, scripts/workflow-reader.spec.ts,
                 scripts/ci-desktop.spec.ts
       covers:   c-1, c-4
       desc:     Moves ci-desktop.spec's job/block/map/steps/branches helpers into
                 readWorkflow(text). There is still no YAML library. Adds `on` triggers and the
                 job keys (needs, permissions, environment, runs-on, if, concurrency) that the
                 release spec needs. ci-desktop.spec switches to the shared reader and keeps its
                 assertions.
       contract: - if readWorkflow(text).job('missing') returns an empty body instead of
                   throwing an error naming 'missing', workflow-reader.spec fails
                 - if a step after a `run: |` block scalar is merged into it, or step.get('uses')
                   and step.run miss a `- uses:` step with `with:`, workflow-reader.spec's fixture
                   fails
                 - if jobKey('needs') does not read both `needs: [a, b]` and a block list as
                   ['a','b'], or triggers() does not read push.tags ['v*'], workflow-reader.spec
                   fails
                 - if the shared steps()/branches() lose the desktop step's Linux branch,
                   ci-desktop.spec 'runs Linux under xvfb-run -a, after the AppArmor userns
                   sysctl' fails
       depends:  t-1

  t-8  Add local update feed and process probe
       files:    scripts/update-feed.ts, scripts/update-feed.spec.ts, scripts/process-probe.ts,
                 scripts/process-probe.spec.ts
       covers:   c-5, c-6
       desc:     UPDATE_FEED_PORT constant. startUpdateFeed({dir, port}) is a node:http server
                 on 127.0.0.1 that serves only regular files directly in dir (with Range) and
                 records requested paths. process-probe parses Get-Process/Get-NetTCPConnection
                 ConvertTo-Json output and `ss -Hltnp` lines into {pid, path, startTime} and
                 pid -> port.
       contract: - if GET /latest.yml does not return the file's bytes, or /../package.json,
                   /%2e%2e/package.json or /sub/x return anything but 404, update-feed.spec fails
                 - if the server's address is not 127.0.0.1, or a busy port resolves on another
                   port instead of rejecting (the URL is baked into build A), update-feed.spec
                   fails
                 - if `Range: bytes=0-9` does not give 206 with exactly 10 bytes (electron-updater's
                   blockmap download), update-feed.spec fails
                 - if requests() does not list '/latest.yml' after it was fetched,
                   update-feed.spec fails
                 - if a single Get-Process object (ConvertTo-Json emits no array for one) is
                   not read as one process, or a '/Date(1731600000000)/' StartTime is not that
                   instant, process-probe.spec fails
                 - if the ss line `LISTEN 0 511 127.0.0.1:40123 0.0.0.0:*
                   users:(("price-check",pid=4242,fd=33))` does not map 4242 -> 40123, or another
                   pid's or a [::] listener is taken, process-probe.spec fails
       depends:  t-1

  t-9  Create release environment, v* tags only
       files:    .github/environments/release.json, scripts/environments.spec.ts
       covers:   c-2, c-4
       desc:     release.json holds the PUT body (deployment_branch_policy with
                 protected_branches false and custom_branch_policies true) plus
                 policies [{name:'v*', type:'tag'}]. The executor applies it with gh api PUT
                 repos/Rivil/price-check/environments/release, then POST
                 .../deployment-branch-policies, then reads it back with GET. No secret is set.
       contract: - if custom_branch_policies is not true, protected_branches is not false, or
                   policies is not exactly [{name:'v*', type:'tag'}] (a branch policy would let a
                   branch push read the signing secrets), environments.spec fails
                 - if release.json has any key matching /secret|CSC_|APPLE_/i, environments.spec
                   fails
                 - executor observes `gh api repos/Rivil/price-check/environments/release/deployment-branch-policies`
                   returning exactly one policy {name:'v*', type:'tag'} before committing
       depends:  t-1

  t-10 Document per-OS install in README
       files:    README.md, scripts/readme.spec.ts
       covers:   c-1
       desc:     The "Install and use" section gains macOS (one dmg for Apple silicon and Intel),
                 Windows (installer, SmartScreen only, no admin) and Linux AppImage (libfuse2,
                 the Ubuntu 24.04+ AppArmor step) subsections. End users only. It names no pnpm
                 script that does not exist yet.
       contract: - if the install section has no Linux part naming libfuse2 and AppArmor,
                   readme.spec fails (decision artefacts)
                 - if README contains '--no-sandbox' anywhere, readme.spec fails (the AppImage
                   keeps the sandbox)
                 - if the macOS part does not say one download serves both Apple silicon and
                   Intel, or the Windows part does not say no administrator rights are needed,
                   readme.spec fails
                 - if README names a `pnpm <x>` that is not a package.json script, the existing
                   readme.spec pnpmCommands check fails
       depends:  t-1

Wave 3
  t-11 Locate, install and verify packaged artefacts
       files:    scripts/packaged-app.ts, scripts/packaged-app.spec.ts,
                 scripts/verify-packaged.ts, scripts/verify-packaged.spec.ts
       covers:   c-1, c-2, c-3
       desc:     packaged-app.ts provides expectedArtefacts(platform, version) from t-2's patterns
                 and locate(outDir), which refuses single-arch mac dirs. It also provides
                 packagedUserDataDir(platform, env, home) and installWindows(installer): run
                 '<installer> /S', then read InstallLocation from the HKCU Uninstall key.
                 CLI `exe` prints the path for PRICE_CHECK_PACKAGED_EXE. verify-packaged.ts:
                 `mac <app> [--signed]` checks lipo, both libsql binaries and (with --signed)
                 codesign/spctl/stapler. `win` checks Get-StartApps AppID === APP_ID and the
                 per-user install. Commands come from pure builders; the runner is injected.
       contract: - if parseLipoArchs('Non-fat file: x is architecture: arm64') passes
                   verifyMac, or 'Architectures in the fat file: x are: x86_64 arm64' fails it,
                   verify-packaged.spec fails (c-2)
                 - if a fake app tree missing app.asar.unpacked/.../@libsql/darwin-x64/index.node
                   (or the darwin-arm64 one) passes verifyMac, verify-packaged.spec fails
                 - if macCommands({signed:false}) contains codesign, spctl or stapler, or
                   {signed:true} lacks exactly `codesign --verify --deep --strict`,
                   `spctl --assess --type execute` and `xcrun stapler validate` on the app, or a
                   fake runner exiting 1 on any one of them leaves the CLI at exit 0,
                   verify-packaged.spec fails
                 - if parseStartApps does not accept a single object as well as an array, or
                   an entry named PRODUCT_NAME whose AppID is the exe path (shortcut without
                   an AUMID) or is missing passes verifyWin, verify-packaged.spec fails (c-3)
                 - if an InstallLocation outside %LOCALAPPDATA%, or the uninstall key under
                   HKLM, passes verifyWin, verify-packaged.spec fails (per-user, no UAC)
                 - if expectedArtefacts('darwin','0.1.5-rc.1') lacks the dmg, the zip or
                   latest-mac.yml, win32 lacks the setup exe or latest.yml, linux lacks the
                   AppImage or latest-linux.yml, or locate() accepts a dir holding mac-arm64/,
                   packaged-app.spec fails
                 - if packagedUserDataDir is not <home>/Library/Application Support/price-check
                   (darwin), <APPDATA>\price-check (win32), or $XDG_CONFIG_HOME/price-check with
                   a <home>/.config fallback (linux), or is built from a literal instead of
                   APP_DIR_NAME, packaged-app.spec fails
                 - if installWindows with a fake installer exiting 2 resolves, or
                   parseRegQuery picks a key whose DisplayName is not PRODUCT_NAME,
                   packaged-app.spec fails
       depends:  t-2

  t-12 Wire updater, tray item and status in main
       files:    src/desktop/main.ts, src/desktop/boundary.spec.ts,
                 scripts/build-desktop.spec.ts, e2e/desktop/harness.e2e.ts
       covers:   c-5, c-6
       desc:     main.ts default-imports electron-updater (CJS). Only when app.isPackaged it
                 builds the updater with the notifier and passes updates to runDesktop. onReady
                 calls the tray handle's setUpdateReady(true). After 'started' it calls start()
                 and publishUpdaterHandle({status, restart: the tray's restartToUpdate}).
                 Unpackaged runs never touch autoUpdater. Executor also runs pnpm check and
                 observes pnpm test:e2e:desktop green.
       contract: - if any non-spec module other than main.ts value-imports 'electron-updater',
                   boundary.spec fails
                 - if the real-entry bundle does not keep electron-updater as a bare external
                   import, or contains 'setFeedURL', build-desktop.spec 'real entry' fails
                 - if an unpackaged launch has Symbol.for('price-check.updater') defined in main
                   (updater constructed outside a packaged build), harness.e2e fails
                 - packaged wiring is proven by t-13 (the app still opens with the updater
                   live) and t-14 (download, notify state, install)
       depends:  t-1, t-4, t-5, t-6

Wave 4
  t-13 Add packaged smoke e2e and its harness
       files:    e2e/packaged/launch-packaged.ts, e2e/packaged/smoke.packaged.ts,
                 playwright.packaged.config.ts, package.json
       covers:   c-1
       desc:     Launches PRICE_CHECK_PACKAGED_EXE with _electron ({executablePath},
                 chromiumSandbox true). The origin comes from the first window's URL, not stdout
                 (a packaged Windows GUI app). It refuses to start while packagedUserDataDir
                 exists. After the run it turns off the login item and removes that dir. Launch 1:
                 empty, libsql check. Quit, then insertWatches puts in an
                 https://shop.e2e.invalid/... watch (r-01). Launch 2: watch listed, target
                 changed through the watch page. Launch 3: new target shown. test:e2e:packaged =
                 'playwright test --config playwright.packaged.config.ts' (testMatch
                 **/*.packaged.ts, workers 1, retries 0, outputDir test-results/packaged).
                 Executor observes package:desktop + test:e2e:packaged green on macOS locally.
       contract: - if launch 1's first window is not http://127.0.0.1:<port>/ showing 'Nothing on
                   your watchlist yet.', or app.isPackaged is false, smoke.packaged fails
                 - if app.getPath('userData') !== packagedUserDataDir(...), smoke.packaged fails
                   (the guard and cleanup would protect the wrong dir)
                 - if process.report.getReport().sharedObjects has no
                   @libsql/<platform>-<arch> .node path under app.asar.unpacked, or has one
                   anywhere else (Electron's temp extraction from inside app.asar),
                   smoke.packaged fails (c-1 outside asar)
                 - if after quit + seed + relaunch the 'E2E Packaged Kettle' card is missing, or
                   after the target change + relaunch the card does not show £12.34,
                   smoke.packaged fails
                 - if launchPackaged with packagedUserDataDir already present spawns any process
                   instead of rejecting, smoke.packaged 'refuses existing data' fails
       depends:  t-4, t-11, t-12

Wave 5
  t-14 Prove update install on Windows and Linux
       files:    e2e/packaged/update.packaged.ts, e2e/packaged/launch-packaged.ts
       covers:   c-5, c-6
       desc:     Runs when PRICE_CHECK_UPDATE_FEED_DIR is set; skipped on darwin (device UAT).
                 Build A is the package.json version with --feed-url
                 http://127.0.0.1:UPDATE_FEED_PORT/. Build B is the next patch. Launch A, quit,
                 seed a watch, start the feed over B, then launch A again and wait for status()
                 'downloaded' B. Windows: handle.restart(), then probe the new process.
                 Linux: app.close() (Quit installs), then relaunch the AppImage path. Both:
                 Playwright relaunch shows getVersion B and the watch.
       contract: - if the feed records no GET of latest.yml (win) / latest-linux.yml (linux)
                   during the launch, update.packaged fails (check at launch)
                 - if status() does not reach 'downloaded' with version B within 180 s, or A's
                   process exits on its own within 30 s after that (a forced restart),
                   update.packaged fails
                 - Windows: if the new process (by install path) has a StartTime not after A's
                   observed exit, or GET / on its listening port lacks the seeded watch title,
                   update.packaged fails (c-6: relaunch after exit, same DB intact)
                 - if the relaunched app's getVersion() !== B, or the seeded watch is missing,
                   update.packaged fails
                 - not runnable on the macOS host: observed green in t-16's PR run on
                   test (windows) and test (linux)
       depends:  t-8, t-12, t-13

  t-15 Add tag-triggered release workflow
       files:    .github/workflows/release.yml, scripts/workflow-policy.ts,
                 scripts/workflow-policy.spec.ts, scripts/release-workflow.spec.ts
       covers:   c-1, c-2, c-4
       desc:     on push tags v*. Job tag (contents read): checkout fetch-depth 0, then
                 merge-base on origin/main, then `release-tag.ts tag`. Three build jobs
                 (macos-15 / windows-2025 / ubuntu-24.04, contents read, no cache): install
                 frozen, vite build + build-desktop, package --version from tag, verify, packaged
                 smoke, upload-artifact. Only the macOS package step reads the five secrets
                 (environment release); it runs apple-credentials, decodes the p8 to
                 $RUNNER_TEMP/AuthKey.p8 and passes --sign. Job publish (needs all four,
                 contents: write, gh only): download, file-set check, refuse if
                 `gh release view` succeeds, then one `gh release create`.
                 WRITE_SCOPE_ALLOWLIST = { 'release.yml': ['contents'] }.
       contract: - if WRITE_SCOPE_ALLOWLIST is not exactly {'release.yml': ['contents']},
                   workflow-policy.spec fails (the 'ships empty' test becomes this pin); if the
                   same job-level contents: write in ci.yml, packages: write in release.yml, or
                   workflow-level contents: write in release.yml is not reported,
                   workflow-policy.spec fails; the real-dir CLI test must still return 0
                 - if release.yml triggers on anything but push tags ['v*'], release-workflow.spec
                   fails
                 - if any job uses actions/cache, any setup-node has `cache:`, any pnpm install
                   lacks --frozen-lockfile, or any checkout lacks persist-credentials: false,
                   release-workflow.spec fails
                 - if `secrets.` appears outside the macOS package step's env, that env is not
                   exactly the five named secrets, `environment: release` is on any job but the
                   macOS build (or its name differs from .github/environments/release.json), or
                   the step's run does not run `release-tag.ts apple-credentials` before
                   decoding and packaging, release-workflow.spec fails (c-4 missing credential)
                 - if the macOS build lacks --sign, or lacks `verify-packaged.ts mac <app>
                   --signed` before upload, or Windows/Linux pass --sign or any --feed-url,
                   release-workflow.spec fails (c-2 before publishing)
                 - if a build job does not run `pnpm test:e2e:packaged` (Windows after the silent
                   install and verify win; Linux under xvfb-run after the sysctl) before its
                   upload-artifact step, release-workflow.spec fails (c-1 on release artefacts)
                 - if publish.needs is not exactly [tag, build-macos, build-windows,
                   build-linux], or publish has an `if:` (always()/failure() would publish
                   after a failed OS build), release-workflow.spec fails
                 - if publish has a checkout, setup-node, or any run line invoking node, pnpm,
                   npm or npx, release-workflow.spec fails (decision: runs no repo or
                   dependency code)
                 - if publish's required-file list is not the union of t-11's
                   expectedArtefacts for darwin, win32 and linux, or `gh release view` does not
                   come before the single `gh release create`, or create lacks --verify-tag or
                   --repo "$GITHUB_REPOSITORY", or --prerelease is not tied to
                   needs.tag.outputs.prerelease, release-workflow.spec fails (c-4 empty and
                   idempotency edges)
                 - if the workflow has no per-ref concurrency group with cancel-in-progress
                   false, release-workflow.spec fails (two runs for one tag)
                 - `pnpm ci:policy` exit 0 over .github/workflows is observed by the executor
       depends:  t-3, t-7, t-9, t-11, t-13

Wave 6
  t-16 Run packaging, checks and packaged e2e in CI
       files:    .github/workflows/ci.yml, scripts/ci-packaged.spec.ts
       covers:   c-1, c-2, c-3, c-5, c-6
       desc:     In the existing test job, after the desktop e2e, steps follow the same
                 RUNNER_OS shell-branch pattern. Package A with CSC_IDENTITY_AUTO_DISCOVERY=false
                 and never --sign; Windows/Linux bake the loopback feed into A. macOS runs
                 verify mac (unsigned). Windows does the silent install, then verify win.
                 Linux installs libfuse2t64. Windows/Linux package B and set
                 PRICE_CHECK_UPDATE_FEED_DIR. Then pnpm test:e2e:packaged (Linux: sysctl then
                 xvfb-run -a). The failure upload covers test-results/packaged and the timeout
                 goes up. Executor pushes and observes test (linux|macos|windows) green on the PR.
       contract: - if any matrix OS can skip the package or packaged-e2e step (a step `if:`,
                   continue-on-error, or a branch without it), or they run before the desktop
                   e2e, ci-packaged.spec fails
                 - if a ci.yml package step passes --sign, lacks env
                   CSC_IDENTITY_AUTO_DISCOVERY: 'false', or ci.yml references secrets.*,
                   ci-packaged.spec fails (PR builds never sign)
                 - if the macOS branch lacks `verify-packaged.ts mac` or passes --signed, or
                   the Windows branch does not run the silent install before
                   `verify-packaged.ts win`, ci-packaged.spec fails (c-2 lipo/libsql, c-3 AUMID
                   and per-user on every PR)
                 - if B is packaged on macOS, or the --feed-url port differs from
                   UPDATE_FEED_PORT (imported), or PRICE_CHECK_UPDATE_FEED_DIR is unset on
                   windows/linux, ci-packaged.spec fails
                 - if Linux's packaged run is not `xvfb-run -a pnpm test:e2e:packaged` after the
                   userns sysctl, or '--no-sandbox' appears in ci.yml or any e2e/packaged/*.ts
                   outside a comment, ci-packaged.spec fails
                 - if playwright.packaged.config's outputDir is not under an uploaded path, or the
                   web/desktop configs collect any e2e/packaged file, or the packaged config
                   collects anything else, ci-packaged.spec fails
                 - if a new job is added instead of steps, rulesets.spec 'ci.yml produces the five
                   gate checks' fails (required checks unchanged)
                 - observed: the PR's test (windows) and test (linux) run t-14's update e2e green,
                   and test (macos) runs verify mac + smoke green
       depends:  t-7, t-11, t-13, t-14
```

## Coverage

| criterion | tasks | proving tests |
|---|---|---|
| c-1 packaged opens empty, saves across relaunch, libsql outside asar; PR + release smoke | t-1, t-2, t-4, t-7, t-10, t-11, t-13, t-15, t-16 | package-desktop.spec (asarUnpack/files), app-paths.spec, smoke.packaged (3 launches + sharedObjects), ci-packaged.spec, release-workflow.spec |
| c-2 universal lipo, both darwin libsql, codesign/spctl/stapler before publish | t-1, t-2, t-9, t-11, t-15, t-16 | build-desktop.spec (both darwin pkgs installed), package-desktop.spec (universal, x64ArchFiles), verify-packaged.spec, PR verify mac, release-workflow.spec (--signed before upload). Gatekeeper open = device UAT |
| c-3 per-user NSIS, no UAC, shortcut AUMID = APP_ID = appId; CI after silent install | t-2, t-11, t-16 | package-desktop.spec (appId import, oneClick/perMachine), verify-packaged.spec (Get-StartApps, HKCU/LOCALAPPDATA), PR verify win. SmartScreen = device UAT |
| c-4 tag gate, one release with all files, rc = prerelease, refusals | t-2, t-3, t-7, t-9, t-15 | release-tag.spec (tag table, credentials), package-desktop.spec (detectUpdateChannel false so latest*.yml), environments.spec, release-workflow.spec (needs, publish no-code, view-before-create, file set), workflow-policy.spec |
| c-5 check at launch + 6 h, background download, one notification, tray item, Restart/Quit install, rc/final rule; CI Win+Linux | t-2, t-5, t-6, t-8, t-12, t-14, t-16 | updater.spec, lifecycle.spec, tray.spec, update-feed.spec, update.packaged (Win restart, Linux quit). macOS = device UAT |
| c-6 Windows relaunch only after old process exit, same DB intact | t-6, t-8, t-12, t-14, t-16 | lifecycle.spec (install after closeDb, no app.relaunch), process-probe.spec, update.packaged Windows (new StartTime > old exit, new server serves the seeded watch) |

Deferred notes folded in: f48477c1 (libsql asar-unpacked per OS) -> t-2, t-13; 805f0b62 (packaged
smoke per OS) -> t-13, t-16; Send-test + click on packaged builds stays device UAT, because
packaged builds refuse the notify seam by design (04 t-4); bc845313 (appId + NSIS AUMID) -> t-2,
t-11; f89d493d (Windows relaunch after exit) -> t-6, t-14.

Spec edges: empty (c-4) -> t-15 file-set check refuses a missing artefact; idempotency (c-4) ->
t-15 view-before-create plus the per-tag concurrency group; concurrency (c-6) -> t-6 ordering plus
t-14's StartTime-after-exit check.

## Judgment calls

- **Packaged steps inside the existing `test` matrix job, not a new job.** A new job would mean editing .github/rulesets/*.json, re-applying them with gh api, and paying a second install+build per OS. Inside the test job, the required check names stay the same (rulesets.spec keeps passing) and the job reuses build/ and dist-desktop/ from test:e2e:desktop (build once).
- **Builder config as a TS module (scripts/package-desktop.ts), not electron-builder.yml.** vitest can assert on the object directly, and the module can import APP_ID. A YAML file would need a YAML parser in specs and could not import APP_ID.
- **"Quit also installs" goes through the lifecycle, with autoInstallOnAppQuit off.** The lifecycle calls installOnExit after closeDb, then exits. I rejected electron-updater's own quit hook for two reasons. The lifecycle ends in app.exit(0), which may never emit 'quit'. And quitAndInstall spawns the NSIS installer before app.quit(), so the installer could kill the app while it is still writing the DB. The c-6 fix is this ordering.
- **No app.relaunch() anywhere.** The installer does the relaunch (--force-run), after this process has exited. That is how c-6 avoids depending on libsql's close.
- **Packaged smoke uses the real per-OS userData, guarded.** It refuses if the dir exists and removes it after the run. I rejected a packaged userData override because app-paths deliberately ignores PRICE_CHECK_USER_DATA in packaged builds. The smoke checks that the guard predicts the right dir (getPath('userData') === packagedUserDataDir).
- **"Saves a watch" = an external seed plus a target edit through the UI, checked across relaunches.** I rejected adding the watch through the UI (a live shop fetch, r-01) and a test shop adapter in shipped code.
- **libsql "outside asar" is checked through process.report sharedObjects in the running packaged app.** I rejected a file-existence check alone. Electron extracts a .node from inside asar to a temp dir, so a file check passes even when the unpacking is broken.
- **The updater handle on Symbol.for('price-check.updater') ({status, restart}) ships in packaged code.** Playwright cannot click the tray, and stdout from a packaged Windows GUI process is unreliable. It is not a feed override. Anyone who can evaluate in main can already reach autoUpdater.
- **Update e2e: A = the package.json version with the loopback feed, which is also the Win/Linux PR smoke build. B = the next patch.** I rejected a third build per OS (cost). The release.yml smoke covers the real GitHub-feed builds.
- **Windows e2e proves Restart (c-6 needs the forced relaunch). Linux proves Quit.** Both modes are unit-tested in lifecycle.spec and updater.spec. I rejected running both paths on both OSes, which would cost two more installs and downloads per PR.
- **rc -> final and final-never-rc are proven by unit tests plus config plus device UAT.** The unit test covers allowPrerelease from the version; the config check is detectUpdateChannel false. CI e2e can't prove this, because a generic feed has no prerelease semantics.
- **serverCwdFor -> app.asar.unpacked, with drizzle/** unpacked.** I rejected asar:false, which contradicts the locked asarUnpack design. I also rejected rewriting migrate.ts to resolve from import.meta.url, which touches the server and web paths.
- **Wave 1 pairs the gitleaks entry with the deps change** (the root of the packaging chain), not with the tag gate. That keeps the critical path at 6 waves. pnpm-lock.yaml is generated, so t-1 has 4 authored files.
- **t-11 merges locate/install with verify** (4 files): Windows install and Windows verify read the same HKCU uninstall key, and splitting them would add a wave.
- **t-14 and t-16 are proven by a PR CI run, not locally.** The dev host is macOS, there is no Docker (locked stack), and Windows/Linux packaged runs are impossible there. Each says so instead of claiming a local green.
- **Electron fuses stay at electron-builder defaults** (node inspect enabled). Playwright needs them to drive the release artefacts' smoke. Turning them off is a later hardening item, not something this phase can prove.
