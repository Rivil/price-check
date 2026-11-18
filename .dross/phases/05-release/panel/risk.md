# Phase 05-release — RISK lens draft

Lens: every task below exists to own one family of failure modes, and each test
contract names the break it catches. Failure modes found by reading the current code
(not hypothetical) are marked **[found]**: they break the packaged app or the update
path on day one if no task owns them.

- **[found]** `loadAdapterHandler` does `process.chdir(APP_ROOT)` and `migrationsFolder()`
  reads `<cwd>/drizzle`. Packaged, APP_ROOT is `…/resources/app.asar`: `chdir` into an
  asar file throws ENOTDIR, so every packaged build dies at startup (t-3).
- **[found]** `runDesktop`'s quit ends in `app.exit(0)`, which skips Electron's `quit`
  event; electron-updater's `autoInstallOnAppQuit` hooks that event, so "Quit also
  installs" would silently never install. A naive `quitAndInstall()` calls `app.quit()`,
  which re-enters the `before-quit` handler, hits `running.quitting` and
  `preventDefault`s forever: the app hangs instead of updating (t-8).
- **[found]** AppImageUpdater spawns the new AppImage *before* the old process exits; the
  new instance loses the single-instance lock and quits as `'second-instance'`, so the
  app never comes back after a Linux update (t-8).
- **[found]** electron-builder derives an `rc` channel from `0.1.5-rc.1` (writes `rc.yml`,
  not `latest.yml`), and electron-updater's GitHubProvider treats `rc` as a custom
  channel that skips untagged finals: an rc install would never take the final (t-6,
  t-7).
- **[found]** `WRITE_SCOPE_ALLOWLIST` is keyed per file, not per job: allowlisting
  `release.yml` lets *every* job in it take `contents: write` unless a test pins the
  build jobs to read (t-17).
- **[found]** The web Playwright config collects `**/*.e2e.ts` everywhere except
  `e2e/desktop/**`, and the desktop config collects everything under `e2e/desktop`: a
  packaged spec in either place gets run by the wrong suite (t-12).
- **[found]** `rulesets.spec` pins exactly five check names; a new CI job for packaging
  either breaks it or runs as a non-required check that cannot block a merge (t-16).
- **[found]** A packaged app ignores `PRICE_CHECK_USER_DATA` (by design), and on macOS
  and Windows Electron's appData ignores env overrides: a packaged test run on a dev
  machine opens and wipes the developer's real `price-check` userData (t-12).

```
Phase 05-release — 17 tasks across 7 waves

Wave 1
  t-1  Gate release tags; allowlist phase tests.json
       files:    .gitleaks.toml, scripts/release-tag.ts, scripts/release-tag.spec.ts
       covers:   c-4
       desc:     .gitleaks.toml gains ^\.dross/phases/05-release/tests\.json$ (the only wave-1
                 task; vitest is red until it lands). release-tag.ts (Node type stripping, no
                 deps): parseReleaseTag(tag), checkRelease({tag, pkgVersion}), isOnMain(sha,
                 cwd) via `git merge-base --is-ancestor <sha> origin/main`, and a CLI that
                 writes version= / prerelease= to $GITHUB_OUTPUT only on success.
       owns:     malformed tag, version mismatch, tag off main, rc detection
       contract: - if the tests.json allowlist lacks the exact anchored 05-release path,
                   gitleaks-config.spec 'every phase allowlisted' fails (red today)
                 - if parseReleaseTag accepts any of 'v0.1.5-rc', 'v0.1.5-rc.0',
                   'v0.1.5-beta.1', 'v0.1.5.1', '0.1.5', 'v01.1.5', 'v0.1.5+b1',
                   'v0.1.5\n', 'refs/tags/v0.1.5', release-tag.spec fails
                 - if 'v0.1.5-rc.2' does not parse to {version:'0.1.5-rc.2', base:'0.1.5',
                   prerelease:true} or 'v0.1.5' to prerelease:false, release-tag.spec fails
                 - if checkRelease passes tag v0.1.6 against package.json 0.1.5, or its error
                   omits either version, release-tag.spec fails
                 - if isOnMain is true for a commit reachable only from a side branch, or false
                   for an older commit on main (temp git repo fixture), release-tag.spec fails
                 - if the CLI writes anything to GITHUB_OUTPUT or exits 0 on a rejected tag,
                   release-tag.spec fails (a half-written output would let builds start)

Wave 2 (each depends t-1)
  t-2  Add packaging deps and dual darwin libsql
       files:    package.json, pnpm-workspace.yaml, pnpm-lock.yaml, scripts/build-desktop.spec.ts
       covers:   c-1, c-2, c-5
       desc:     electron-updater (exact x.y.z) in dependencies; electron-builder and
                 @electron/asar (exact) in devDependencies. pnpm-workspace.yaml gains
                 supportedArchitectures {os:[current], cpu:[current, arm64, x64],
                 libc:[current]}; onlyBuiltDependencies unchanged. Lockfile regenerated;
                 `pnpm install --frozen-lockfile` observed clean before commit.
       owns:     updater not shipped, unpinned build tool, install-script creep, x64 libsql
                 missing on the arm64 mac runner
       contract: - if electron-updater sits in devDependencies (electron-builder would not ship
                   it and the packaged main.js dies on its bare import) or is not an exact
                   x.y.z, build-desktop.spec 'runtime deps' fails
                 - if electron-builder or @electron/asar is not an exact x.y.z devDependency,
                   build-desktop.spec fails
                 - if onlyBuiltDependencies gains anything beyond electron and esbuild, the
                   existing 'allows install scripts for exactly electron and esbuild' fails
                 - if supportedArchitectures drops arm64 or x64 from cpu, or widens libc to
                   musl, build-desktop.spec fails; on darwin, if require.resolve of either
                   @libsql/darwin-arm64 or @libsql/darwin-x64 from @libsql/client's dir
                   throws, build-desktop.spec 'both darwin binaries installed' fails

  t-3  Run the server from app.asar.unpacked
       files:    src/desktop/app-root.ts, src/desktop/app-root.spec.ts, src/desktop/main.ts
       covers:   c-1
       desc:     serverCwd(appRoot): appRoot whose last segment ends in '.asar' ->
                 `${appRoot}.unpacked`, else appRoot unchanged. main.ts passes serverCwd(APP_ROOT)
                 to loadAdapterHandler as its chdir target; HANDLER_URL and ICON_DIR stay
                 under APP_ROOT (Electron reads both from inside asar). t-6 unpacks drizzle/**.
       owns:     ENOTDIR chdir into asar, migrations not found when packaged
       contract: - if serverCwd('/Applications/Price Check.app/Contents/Resources/app.asar') is
                   not '…/app.asar.unpacked', or the Windows form 'C:\\…\\resources\\app.asar'
                   loses its drive or separators, app-root.spec fails
                 - if serverCwd changes the repo root, or a dir merely containing '.asar'
                   mid-path ('/home/u/x.asar.d/app'), app-root.spec fails
                 - if migrationsFolder(serverCwd(packagedRoot)) is not
                   '<…>/app.asar.unpacked/drizzle', app-root.spec fails
                 - if main.ts still passes APP_ROOT as the chdir target (source read ?raw),
                   app-root.spec 'main wires serverCwd' fails; build-desktop.spec 'real entry'
                   fails if main.ts stops building

  t-4  Create the tag-only release environment
       files:    .github/environments/release.json, scripts/environments.spec.ts
       covers:   c-4
       desc:     release.json records the environment as applied: deployment_branch_policy
                 {protected_branches:false, custom_branch_policies:true} and one policy
                 {name:'v*', type:'tag'}; no reviewers, no secrets. Applied with
                 `gh api -X PUT repos/Rivil/price-check/environments/release` plus the
                 deployment-branch-policies POST, then read back. No secret values set.
       owns:     signing secrets reachable from a branch or PR run
       contract: - if release.json allows protected branches, lacks custom policies, or its
                   policies differ from exactly [{name:'v*', type:'tag'}] (a branch-type
                   'v*' would match a branch named v1), environments.spec fails
                 - if release.json carries any key named like a secret value (secrets,
                   CSC_*, APPLE_*), environments.spec fails
                 - if the `gh api …/environments/release/deployment-branch-policies` read-back
                   differs from release.json's policy list, the task is not done (observed by
                   the executor, output pasted into the task log)

  t-5  Document AppImage libfuse2 and AppArmor
       files:    README.md, scripts/readme.spec.ts
       covers:   c-1
       desc:     Linux install lists libfuse2 (libfuse2t64 on 24.04) and the Ubuntu 24.04+
                 AppArmor step that keeps the sandbox; drops the "Not released yet" note.
       owns:     users told to run --no-sandbox, AppImage that will not start on stock Ubuntu
       contract: - if the Install section's Linux item lacks 'libfuse2' or the AppArmor step
                   (apparmor_restrict_unprivileged_userns or an AppArmor profile), readme.spec
                   'Linux run notes' fails
                 - if README anywhere suggests '--no-sandbox' or 'APPIMAGE_EXTRACT_AND_RUN'
                   to end users, readme.spec fails
                 - if the 'Not released yet' note survives, readme.spec fails

  t-8  Install after shutdown; wait for predecessor
       files:    src/desktop/lifecycle.ts, src/desktop/lifecycle.spec.ts
       covers:   c-5, c-6
       desc:     LifecycleDeps gains update {pending(): boolean; install(): void},
                 predecessorPid: number | null and isProcessAlive(pid). Quit: shutdown
                 (scheduler, server, DB) then, if update.pending(), mark exiting, set
                 PRICE_CHECK_PREDECESSOR_PID=<pid> in process.env and call install(); a
                 re-entrant before-quit while exiting passes through (no preventDefault); a
                 throwing install, or no exit 5s after it, ends in app.exit(0). Startup: a lost
                 lock with predecessorPid set polls isProcessAlive until false (cap 30s), then
                 retries the lock once before quitting as 'second-instance'.
       owns:     install skipped on quit (app.exit bypasses 'quit'), quit hang on
                 quitAndInstall re-entry, install racing an open DB, relaunch losing the lock
       contract: - if 'install' is recorded before 'stop', 'close server' or 'closeDb' in
                   lifecycle.spec's call-order log, lifecycle.spec fails (c-6)
                 - if a quit with update.pending() false calls install, or one with it true
                   calls app.exit(0) instead of install, lifecycle.spec fails
                 - if the before-quit fired by install's own app.quit() is preventDefault'ed
                   (the hang), or install runs twice across two quits, lifecycle.spec fails
                 - if a throwing install, or an install after which no exit comes within 5s
                   (fake timers), leaves the process alive, lifecycle.spec fails
                 - if a shutdown that hits SHUTDOWN_DEADLINE_MS skips the pending install,
                   lifecycle.spec fails
                 - if install is called without process.env.PRICE_CHECK_PREDECESSOR_PID equal
                   to the running pid, lifecycle.spec fails
                 - if a lost lock with predecessorPid set quits before isProcessAlive returns
                   false, or takes the lock and starts while it is still true, or waits past
                   30s, lifecycle.spec fails; with predecessorPid null a lost lock quits at
                   once (existing second-instance tests keep passing)

Wave 3
  t-6  Write the electron-builder config
       files:    scripts/desktop-builder-config.ts, scripts/desktop-builder-config.spec.ts
       depends:  t-2, t-3
       covers:   c-1, c-2, c-3, c-4, c-5
       desc:     builderConfig({mode:'release'|'ci', version, feedUrl?}) -> Configuration
                 (type-only electron-builder import) and expectedReleaseAssets(version).
                 appId = APP_ID; productName 'Price Check'; artifactName
                 'price-check-${version}-${os}-${arch}.${ext}'; files allowlist (build/**,
                 dist-desktop/**, drizzle/**, src/desktop/assets/**, package.json);
                 asarUnpack libsql, @libsql/*, drizzle/**; npmRebuild false;
                 detectUpdateChannel false; mac universal dmg+zip, x64ArchFiles for both
                 darwin .node, notarize only in release, identity '-' in ci; win nsis x64
                 oneClick perMachine false; linux AppImage x64; publish github
                 Rivil/price-check in release, generic feedUrl in ci.
       owns:     wrong appId, asset names GitHub rewrites, native binary inside asar, dev
                 files shipped, rc channel files, localhost feed in a release, unsigned
                 notarize skip
       contract: - if appId is not the APP_ID import (source read) or differs from
                   'io.github.rivil.price-check', config.spec fails (c-3 AUMID drift)
                 - if any artifactName expansion for every target contains whitespace (GitHub
                   renames 'Price Check' assets to 'Price.Check', and latest.yml then 404s),
                   config.spec fails
                 - if asarUnpack does not match node_modules/@libsql/linux-x64-gnu/index.node,
                   node_modules/@libsql/win32-x64-msvc/index.node, both darwin paths and
                   drizzle/0000_x.sql, or npmRebuild is not false, config.spec fails
                 - if mac.x64ArchFiles does not match both node_modules/@libsql/darwin-arm64
                   and darwin-x64 .node paths (@electron/universal refuses an identical Mach-O
                   in both slices), config.spec fails
                 - if files lets through local.db, .env, any *.db, src/lib/**, e2e/**, .dross/**
                   or scripts/**, config.spec fails
                 - if detectUpdateChannel is not false (an rc build would write rc.yml, not the
                   latest*.yml c-4 publishes), config.spec fails
                 - if mode 'release' yields any publish other than exactly github
                   Rivil/price-check, or accepts a feedUrl, or mode 'ci' accepts a feedUrl that
                   is not http://127.0.0.1:<port>/, config.spec fails
                 - if notarize is true in ci mode or not true in release mode, or ci mode lacks
                   identity '-', config.spec fails
                 - if nsis perMachine is not false / oneClick not true, or any target lists an
                   arch other than mac universal / win x64 / linux x64, config.spec fails
                 - if expectedReleaseAssets('0.1.5-rc.1') is not exactly the dmg, zip, exe,
                   AppImage, their blockmaps and latest.yml, latest-mac.yml, latest-linux.yml,
                   config.spec fails

  t-7  Build the update controller; prove channels
       files:    src/desktop/updater.ts, src/desktop/updater.spec.ts,
                 src/desktop/updater-channel.spec.ts
       depends:  t-2
       covers:   c-5
       desc:     createUpdater({autoUpdater, isPackaged, notifier, onReady, setInterval}):
                 inert unless packaged; sets allowPrerelease false, autoDownload true,
                 autoInstallOnAppQuit false (t-8 installs), allowDowngrade false; attaches
                 'error' before the first check; checks at start and every 6h, skipping a
                 check while one is in flight; on update-downloaded notifies once per version
                 and calls onReady. Exposes pending(), install() (quitAndInstall(true, true))
                 and a read-only state on globalThis[Symbol.for('price-check.update')]
                 {downloaded, notified[]} for the packaged e2e. No electron import.
                 updater-channel.spec runs electron-updater's real GitHubProvider (host option
                 at a local http fake serving releases.atom, /releases/latest and latest.yml).
       owns:     crash on 'error' with no listener, forced restart, notification spam on
                 every 6h re-emit, rc/final channel selection, update in dev builds
       contract: - if an unpackaged updater ever calls checkForUpdates, updater.spec fails
                 - if 'error' has no listener when the first check starts, or a rejected
                   checkForUpdates rejects out of the controller or stops the 6h timer,
                   updater.spec fails
                 - if checks are not exactly at 0 and 6h (none at 5h59m), or a check starts
                   while one is pending, updater.spec fails (fake timers)
                 - if update-downloaded for 0.1.5 emitted twice notifies twice, or one for 0.1.6
                   afterwards does not notify again, updater.spec fails
                 - if, 48h after a download with no Restart/Quit, quitAndInstall was called,
                   updater.spec fails (never a forced restart)
                 - if allowPrerelease is true for a '0.1.5-rc.1' current version (the library's
                   own default), updater.spec fails
                 - if GitHubProvider, current 0.1.5-rc.1, feed {v0.1.5, v0.1.5-rc.1}, does not
                   resolve 0.1.5, updater-channel.spec 'rc takes final' fails
                 - if GitHubProvider, current 0.1.5, feed {v0.1.6-rc.1 prerelease, v0.1.5 latest},
                   resolves anything newer than 0.1.5, updater-channel.spec 'final never takes
                   rc' fails
                 - if the fake server sees any request for rc.yml / rc-*.yml, updater-channel.spec
                   fails (pairs with t-6 detectUpdateChannel false)

Wave 4
  t-9  Add the packaging CLI with credential gate
       files:    scripts/package-desktop.ts, scripts/package-desktop.spec.ts, package.json,
                 .gitignore
       depends:  t-6
       covers:   c-2, c-4
       desc:     `pnpm package:desktop [--release] [--version x] [--feed url]` builds the host
                 OS target only via electron-builder's build() with publish 'never'. Refuses
                 when build/handler.js or dist-desktop/main.js is missing. Non-release sets
                 CSC_IDENTITY_AUTO_DISCOVERY=false. Release on darwin refuses unless CSC_LINK,
                 CSC_KEY_PASSWORD, APPLE_API_KEY (an existing non-empty file),
                 APPLE_API_KEY_ID and APPLE_API_ISSUER are set, naming only missing variables.
                 Output dir (release/) gitignored.
       owns:     notarisation skipped with a warning, secret value echoed, stale or missing
                 bundles packaged, accidental upload, cross-OS build
       contract: - if missingAppleCredentials drops any of the five names, or a release run
                   with one missing reaches build(), package-desktop.spec fails (c-4 "missing
                   Apple credential publishes nothing")
                 - if stdout or stderr of a refused run contains any sentinel value seeded in
                   the five variables, package-desktop.spec fails (secret-handling rule 1)
                 - if APPLE_API_KEY pointing at a missing or empty file passes, package-desktop.spec
                   fails
                 - if build() is ever called with publish other than 'never', or a non-release
                   run leaves CSC_IDENTITY_AUTO_DISCOVERY unset, package-desktop.spec fails
                   (build() injected)
                 - if a missing build/handler.js or dist-desktop/main.js reaches build(), or
                   '--win' on darwin is accepted, package-desktop.spec fails
                 - if '--version 0.1.5-rc' or '--version latest' is accepted, package-desktop.spec
                   fails
                 - if /release is not gitignored (prettier --check would then read latest.yml
                   after a local package), package-desktop.spec fails

  t-10 Verify packaged layout and update files
       files:    scripts/verify-package.ts, scripts/verify-package.spec.ts
       depends:  t-6
       covers:   c-1, c-2, c-4
       desc:     verifyPackage({platform, outDir, version, mode}) over the real output: asar
                 header via @electron/asar listPackage + extractFile, unpacked dir walk, the
                 packaged package.json version, app-update.yml provider, latest*.yml
                 (version, files[].url present on disk, sha512 set), and on darwin `lipo
                 -archs` output. CLI exits 1 listing every violation.
       owns:     .node inside asar, wrong per-OS libsql set, dev files shipped, version not
                 stamped, latest.yml pointing at a missing file, release built with a CI feed,
                 single-arch mac binary
       contract: - if a fixture asar (built with @electron/asar in a temp dir) holds
                   @libsql/*/*.node packed rather than unpacked, verify-package.spec fails
                 - if darwin unpacked lacks darwin-x64 or darwin-arm64, or linux ships
                   linux-arm64-gnu / musl, or win ships anything but win32-x64-msvc,
                   verify-package.spec fails
                 - if any .db, .env, .dross/, e2e/ or src/lib/ entry in the asar passes,
                   verify-package.spec fails
                 - if the packaged package.json version or latest*.yml version differs from
                   the stamped version (e.g. 0.1.5 vs 0.1.5-rc.1), verify-package.spec fails
                 - if a latest*.yml files[].url names a file absent from outDir, or contains
                   whitespace, or lacks sha512, verify-package.spec fails
                 - if mode 'release' meets app-update.yml provider generic, or mode 'ci' meets
                   github, verify-package.spec fails
                 - if parseLipoArchs('arm64') (missing x86_64) passes, verify-package.spec fails

  t-11 Wire updater into main and tray
       files:    src/desktop/main.ts, src/desktop/tray.ts, src/desktop/tray.spec.ts,
                 src/desktop/boundary.spec.ts
       depends:  t-3, t-7, t-8
       covers:   c-5
       desc:     main.ts imports autoUpdater from electron-updater, builds createUpdater with
                 app.isPackaged and the existing notifier, passes update {pending, install}
                 and predecessorPid (read from PRICE_CHECK_PREDECESSOR_PID before
                 loadAdapterHandler swaps env, then deleted) to runDesktop. tray.ts menu gains
                 'Restart to update' only once onReady fired; its click calls app.quit() (the
                 lifecycle path installs).
       owns:     restart bypassing shutdown, updater in non-main modules, runtime feed override
       contract: - if trayMenuTemplate lists 'Restart to update' before ready, or not after, or
                   its click calls anything but the quitApp action, tray.spec fails
                 - if any non-spec src/desktop file other than main.ts imports
                   'electron-updater', boundary.spec fails (it pulls electron into unit tests)
                 - if any non-spec src/desktop file mentions setFeedURL, forceDevUpdateConfig or
                   updateConfigPath, boundary.spec 'no runtime feed override' fails
                 - if main.ts reads PRICE_CHECK_PREDECESSOR_PID after loadAdapterHandler (source
                   order), boundary.spec fails; if the bundle stops building or inlines
                   electron-updater, build-desktop.spec 'real entry' / 'leaves other packages as
                   bare imports' fails

  t-12 Add packaged harness guards and config split
       files:    scripts/packaged-app.ts, scripts/packaged-app.spec.ts,
                 playwright.packaged.config.ts, playwright.config.ts
       depends:  t-6
       covers:   c-1
       desc:     packaged-app.ts: executablePath({platform, outDir, installDir}) per OS,
                 packagedUserData(platform, appData), assertPackagedRunAllowed(env) (CI ===
                 'true' only), originFromWindowUrl(url). playwright.packaged.config.ts:
                 testDir e2e/packaged, workers 1, retries 0, forbidOnly in CI. The web config's
                 testIgnore gains '**/e2e/packaged/**'.
       owns:     wiping a developer's real userData, packaged specs run by the wrong suite
       contract: - if assertPackagedRunAllowed passes with CI unset or 'false', packaged-app.spec
                   fails
                 - if executablePath for darwin is not '<out>/mac-universal/Price Check.app/
                   Contents/MacOS/Price Check', for win32 not '<install>/Price Check.exe', or
                   for linux not the single '<out>/price-check-<v>-linux-x86_64.AppImage'
                   (two AppImages in outDir must throw), packaged-app.spec fails
                 - if the web or desktop config collects e2e/packaged/smoke.e2e.ts, or the
                   packaged config collects anything outside e2e/packaged, packaged-app.spec
                   'config split' fails
                 - if packagedUserData ignores APP_DIR_NAME, packaged-app.spec fails

Wave 5
  t-13 Run the packaged smoke on each OS
       files:    e2e/packaged/launch.ts, e2e/packaged/smoke.e2e.ts, package.json
       depends:  t-3, t-9, t-10, t-11, t-12
       covers:   c-1
       desc:     launch.ts: assertPackagedRunAllowed, removes the real userData, launches the
                 executable through _electron with an allowlisted env, takes the origin from
                 the first window URL (not stdout). smoke.e2e: fresh launch -> empty
                 watchlist; quit; seed one .invalid watch via e2e/desktop/seed-child.ts;
                 relaunch twice -> listed; process.report sharedObjects check; darwin
                 extra: spawn under `arch -x86_64`, read the listening line, GET the
                 watchlist. Script test:e2e:packaged.
       owns:     packaged-only startup crash, libsql loaded from asar, migrations absent,
                 x64 slice of the universal app broken, update-feed failure taking the app down
       contract: - if the packaged app does not reach an empty watchlist on first launch (the
                   ENOTDIR / migrations failures t-3 removes), smoke.e2e 'empty' fails
                 - if the seeded watch is not listed after each of two relaunches, smoke.e2e
                   'persists' fails
                 - if no path in process.report.getReport().sharedObjects matches
                   app.asar.unpacked/node_modules/@libsql/, or any matches app.asar/ without
                   .unpacked, smoke.e2e 'libsql outside asar' fails
                 - on darwin, if the arch -x86_64 launch does not serve the seeded watch (darwin-
                   x64 slice or binary missing), smoke.e2e 'x64 slice' fails
                 - if the CI build's unreachable loopback feed makes the app exit or the window
                   error within 15s of launch, smoke.e2e 'offline update check' fails

  t-14 Check per-user install and shortcut AUMID
       files:    scripts/windows-install.ts, scripts/windows-install.spec.ts,
                 e2e/packaged/windows-install.e2e.ts
       depends:  t-9, t-12
       covers:   c-3
       desc:     Pure parsers: requestedExecutionLevel from the installer bytes' embedded
                 manifest, `reg query` output to {hive, InstallLocation, UninstallString},
                 the PowerShell Shell.Application ExtendedProperty('System.AppUserModel.ID')
                 output. windows-install.e2e (skipped off win32): silent `/S` install, then
                 the four checks against the installed app.
       owns:     UAC prompt for users, machine-wide install, toast-dropping AUMID mismatch
       contract: - if executionLevel parses 'requireAdministrator' or 'highestAvailable' as
                   allowed, or a manifest with none as asInvoker, windows-install.spec fails
                 - if an uninstall key under HKLM, or an InstallLocation outside %LOCALAPPDATA%,
                   passes, windows-install.spec fails
                 - if parseAumid returns anything but the exact trimmed value (CRLF, BOM),
                   windows-install.spec fails
                 - on windows CI, if the installer's level is not asInvoker, the HKCU key is
                   absent, or the Start Menu 'Price Check.lnk' AUMID != APP_ID,
                   windows-install.e2e fails

Wave 6
  t-15 Prove updates and Windows relaunch order
       files:    e2e/packaged/feed-server.ts, e2e/packaged/update.e2e.ts
       depends:  t-13, t-14
       covers:   c-5, c-6
       desc:     feed-server serves the new build's output dir on 127.0.0.1:<fixed port>
                 only. update.e2e (skipped on darwin: device UAT): install or place the old
                 (0.0.1, same feed) build, seed a watch, launch, poll the update state until
                 downloaded == new version, quit through app.quit(), wait for the old pid to
                 exit, find the relaunched process, then relaunch under Playwright to read
                 app.getVersion() and the watchlist.
       owns:     update never offered, duplicate notification, Quit not installing, relaunch
                 before old exit (Windows), data loss across update, AppImage replacement
       contract: - if the old build's state never reaches downloaded === the new version within
                   120s, update.e2e 'downloads' fails
                 - if state.notified holds the new version other than exactly once after a
                   second forced check, update.e2e fails
                 - if after app.quit() the installed app does not report the new version, or
                   the seeded watch is gone, or `PRAGMA integrity_check` (via seed-child) is not
                   'ok', update.e2e 'installed on quit' fails
                 - on win32, if the relaunched process's CreationDate (Get-CimInstance) is
                   earlier than the observed exit of the old pid, update.e2e 'relaunch after
                   exit' fails (c-6)
                 - on linux, if the AppImage at the original path is not the new version (the
                   updater replaced a different file), update.e2e fails
                 - if feed-server binds anything but 127.0.0.1, update.e2e fails

  t-17 Add release workflow and write allowlist
       files:    .github/workflows/release.yml, scripts/workflow-policy.ts,
                 scripts/workflow-policy.spec.ts, scripts/release-workflow.spec.ts
       depends:  t-1, t-4, t-9, t-10, t-13, t-14
       covers:   c-1, c-2, c-4
       desc:     On push tags 'v*'. check (contents: read, fetch-depth 0, no install): node
                 scripts/release-tag.ts; outputs version, prerelease, expected assets. Three
                 builds (macos-15, windows-2025, ubuntu-24.04; contents: read): frozen install,
                 web + desktop build, package --release --version, verify-package, packaged
                 smoke (Windows: silent install first), mac: decode the p8 to
                 $RUNNER_TEMP/AuthKey.p8, then codesign --verify --deep --strict, spctl
                 --assess, stapler validate; upload artifact. publish (needs all four, only
                 contents: write, no checkout, only gh): compare downloaded names to expected,
                 refuse if any release (draft included) exists for the tag, create a draft
                 with every file at once (--prerelease for rc), then undraft.
                 WRITE_SCOPE_ALLOWLIST = { 'release.yml': ['contents'] }.
       owns:     partial release live, build job with write token, secrets in PR/Win/Linux
                 or argv, cache poisoning, publish after a failed build, overwrite of an
                 existing release, unsigned mac shipped
       contract: - if WRITE_SCOPE_ALLOWLIST is not exactly { 'release.yml': ['contents'] },
                   workflow-policy.spec 'allowlist' fails (replaces 'ships empty')
                 - if any job other than publish has a permission other than contents: read, or
                   publish has more than contents: write, release-workflow.spec fails (the
                   allowlist is per file, not per job)
                 - if publish has a checkout, setup-node, pnpm or any `uses:` other than
                   download-artifact, or a run line invoking node/pnpm/npx, release-workflow.spec
                   fails
                 - if publish's needs lacks check or any of the three builds, or any job has
                   `if: always()` / `if: ${{ !cancelled() }}`, release-workflow.spec fails
                 - if `secrets.` appears outside the mac package step's env, appears inside any
                   `run:` body, or environment: release is on any job but the mac build,
                   release-workflow.spec fails
                 - if release.yml has actions/cache, setup-node `cache:`, a non-frozen install,
                   a checkout without persist-credentials: false, cancel-in-progress: true, or a
                   trigger other than push tags 'v*', release-workflow.spec fails
                 - if the mac job lacks codesign --verify --deep --strict, spctl --assess or
                   stapler validate between package and upload, or any build lacks
                   verify-package and test:e2e:packaged before upload, release-workflow.spec
                   fails; if ci.yml contains any of the three, it fails too
                 - running publish's extracted run block under bash with a stub gh on PATH
                   (skipped on win32): an existing release for the tag -> no create call and
                   exit 1; an asset list one short of expected -> no create; a create that
                   fails -> no undraft; an rc tag -> create carries --prerelease, a final tag
                   does not; the draft is undrafted only after create with every file
                   succeeded; release-workflow.spec fails on any deviation (c-4 idempotency
                   and empty edges)
                 - `pnpm ci:policy` exits 0 over the real .github/workflows (observed)

Wave 7
  t-16 Package, smoke and update on PR CI
       files:    .github/workflows/ci.yml, scripts/ci-desktop.spec.ts
       depends:  t-13, t-14, t-15
       covers:   c-1, c-3, c-5, c-6
       desc:     Steps added to the existing `test` matrix job (no new job, no new check
                 name), after the desktop e2e: package (ci mode, loopback feed), verify-package,
                 then per OS: Windows silent install + windows-install.e2e + smoke on the
                 installed app; Linux smoke under xvfb with the existing AppArmor sysctl;
                 macOS smoke incl. x64 slice with CSC_IDENTITY_AUTO_DISCOVERY=false. Windows
                 and Linux then package the 0.0.1 build and run update.e2e. Output dirs join
                 the failure upload.
       owns:     packaged checks not gating merges, sandbox dropped on Linux, signing
                 attempted in PRs
       contract: - if any matrix OS lacks package -> verify-package -> test:e2e:packaged, or
                   windows lacks the install check before the smoke, ci-desktop.spec fails
                 - if windows or linux lacks the 0.0.1 package + update.e2e step, or macos runs
                   update.e2e, ci-desktop.spec fails
                 - if a packaged step on Linux lacks the sysctl/xvfb branch or any ci.yml line
                   has --no-sandbox, ci-desktop.spec fails
                 - if ci.yml references `secrets.`, sets CSC_LINK, or a mac packaging step
                   lacks CSC_IDENTITY_AUTO_DISCOVERY: 'false', ci-desktop.spec fails
                 - if a new job appears, rulesets.spec 'ci.yml produces the five gate checks'
                   fails (required checks unchanged)
                 - the PR's CI run is green on test (linux), test (macos), test (windows) with
                   these steps executed (observed, not inferred)
```

## Coverage

| criterion | tasks |
| --- | --- |
| c-1 packaged smoke ×3 OS, libsql outside asar, PR + release | t-2, t-3, t-5, t-6, t-10, t-12, t-13, t-16, t-17 |
| c-2 universal mac, both libsql, lipo, codesign/spctl/stapler | t-2, t-6, t-9, t-10, t-17 |
| c-3 per-user NSIS, no UAC, shortcut AUMID = APP_ID | t-6, t-14, t-16 |
| c-4 tag gate, one release, rc pre-release, refuse cases | t-1, t-4, t-6, t-9, t-10, t-17 |
| c-5 launch + 6h check, one notification, tray item, Quit installs, rc/final, CI Win+Linux | t-2, t-7, t-8, t-11, t-15, t-16 |
| c-6 Windows relaunch only after old process exit | t-8, t-15, t-16 |

Spec edges: empty (c-4) -> t-17 asset-count refusal; idempotency (c-4) -> t-17 existing-release
refusal; concurrency (c-6) -> t-8 install-after-shutdown and predecessor wait, t-15 creation-time
check. Device-UAT parts (Gatekeeper, SmartScreen, toast display, mac update) are not tasks.

## Judgment calls

- Chose to fix the asar `chdir` with a dedicated task (t-3); rejected leaving it to the smoke to discover, because every packaged task downstream would be red with no owner.
- Chose installing from the lifecycle's own shutdown (`autoInstallOnAppQuit: false` plus `install()` after closeDb, t-8); rejected relying on electron-updater's on-quit hook, because `app.exit(0)` never emits `quit`.
- Chose a predecessor-pid wait on a lost lock (t-8); rejected trusting NSIS file replacement alone, because the AppImage relaunch provably races the lock and c-6 asks for ordering that does not rely on the installer. The judge can drop it to Windows-only, but not to nothing.
- Chose `allowPrerelease: false` always plus `detectUpdateChannel: false`, and a test against the real GitHubProvider (t-7); rejected trusting electron-updater's prerelease/channel defaults, which route an rc install to `rc.yml` and away from the final.
- Chose packaged steps inside the existing `test` matrix job (t-16); rejected a new `package` job, which would either break rulesets.spec or run as a non-required check that cannot block a merge.
- Chose to build "new" once (the smoke artefact) and package only the 0.0.1 "old" a second time, per OS; rejected a separate pair of update-only builds (an extra package run per OS).
- Chose a CI-only guard for every packaged run (t-12); rejected env-based userData isolation, because Electron's appData ignores env on macOS and Windows, so a local run would wipe the developer's real data.
- Chose the origin from the first window URL in the packaged harness; rejected parsing stdout, which a packaged Windows GUI-subsystem app may not deliver.
- Chose `process.report` sharedObjects as the runtime "libsql outside asar" proof, plus the static layout check (t-10); rejected the layout check alone, which proves where files sit, not which one loaded.
- Chose an `arch -x86_64` launch of the universal app on the arm64 runner (t-13); rejected leaving the x64 slice to device UAT, since an Intel friend's broken app would otherwise ship unseen. Fails loudly if Rosetta is missing on the runner.
- Chose create-as-draft-then-undraft in one publish job, with existence checked through the releases list (drafts included); rejected `gh release view <tag>`, which misses drafts left by a failed run, and a plain create, whose mid-upload failure leaves a live release with a partial latest*.yml set. Still "every file at once" per the locked decision.
- Chose `APPIMAGE_EXTRACT_AND_RUN=1` in CI only (not documented for users) over an unpinned `apt-get install libfuse2t64`; the README still tells users to install libfuse2, and device UAT covers that path.
- Chose own-module ownership for c-3's checks (t-14 pure parsers + one win32 e2e); rejected inline PowerShell in ci.yml, which cannot be unit-tested and would fail silently on output-format drift (BOM, CRLF).
- Chose `@electron/asar` as an explicit exact-pinned devDependency (t-2); rejected hand-parsing the asar header, a second parser to get wrong; it is already in the tree via electron-builder.
