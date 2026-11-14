# 05-release — panel synthesis

Judge's code checks, run before any graft was accepted (branch phase/05-release):

- **Real.** `loadAdapterHandler` runs `process.chdir(appRoot)`, and main.ts passes `APP_ROOT`, which is `…/app.asar` once packaged. `migrationsFolder()` resolves `<cwd>/drizzle` (src/desktop/server.ts, src/lib/server/db/migrate.ts).
- **Real.** The lifecycle's `before-quit` always calls `preventDefault()`, returns early once `running.quitting` is set, and ends in `app.exit(0)`. So `autoInstallOnAppQuit` never fires, and the `app.quit()` inside electron-updater's `quitAndInstall` re-enters a handler that swallows it (src/desktop/lifecycle.ts).
- **Real.** A launch that loses the single-instance lock quits at once. Nothing waits for a predecessor, so an AppImage relaunch spawned before the old process exits is lost.
- **Real (library behaviour, from my reading of electron-updater).** An `x.y.z-rc.N` app version turns on `allowPrerelease` by default. GitHubProvider then treats `rc` as a custom channel and skips untagged finals. Separately, electron-builder's `detectUpdateChannel` writes `rc*.yml`. I could not open the library source locally because electron-updater is not installed yet. t-4's real-provider spec is the arbiter (see D2).
- **Real.** `WRITE_SCOPE_ALLOWLIST` is keyed by file basename (`allowlist[basename(file)]`), so every job in a listed file may write.
- **Real, half of the claim.** The web config collects `**/*.e2e.{ts,js}` everywhere except `e2e/desktop/**`, so it would pick up `e2e/packaged/*.e2e.ts`. The desktop config collects only `e2e/desktop`.
- **Real.** rulesets.spec pins exactly five checks: static, gitleaks and test (linux|macos|windows).
- **Real.** `resolveUserDataDir` ignores `PRICE_CHECK_USER_DATA` when packaged.
- **Real (mvp-only finding).** electron-builder's default `directories.buildResources` is `build`, and that directory is never packed into the app. adapter-node writes `build/handler.js`, which `/build` gitignore confirms is the output dir. A default config would ship without the server.
- **README.** It still carries "Not released yet". readme.spec already requires every listed `pnpm` command to exist.

## Scores

| draft | criteria coverage | test-contract specificity | granularity | wave correctness (vitest+lint green per commit) |
|---|---|---|---|---|
| risk | Full c-1..c-6, plus 8 code-verified packaging/update bugs that the other drafts mostly miss (asar chdir, rc channel, AppImage lock race, per-file allowlist). Misses buildResources. | High: names the surface and the break for each contract, with edge tables (tag forms, asset names, sentinels). A few contracts are observed only. | 17 tasks: over target. t-4 (env) and t-5 (README) are thin, and config and CLI are split. | Green per commit. Gitleaks is the only wave-1 task. 7 waves is the longest path. The CI-only packaged guard means the smoke is never observed before the PR. |
| mvp | All six touched, but c-2 signing is static-only. Encodes the rc bug: allowPrerelease = isRc contradicts its own "rc takes final" provider contract. No Linux relaunch-race owner. Unique catch: buildResources. | Medium-high, though contracts are bundled across concerns (t-5 carries c-1, c-2 and c-3 checks in one e2e). | 8 tasks: too coarse. t-2 is 6 files over 3 concerns, and t-8 mixes the update e2e with the CI wiring. | t-4 goes red as designed: its provider contract fails under its own flag rule. Otherwise green. Gitleaks is the only wave-1 task (paired with README). |
| verification | Full c-1..c-6 with the proof kind stated for each contract. Pins the rc bug: allowPrerelease true for rc. Sidesteps the AppImage race by proving only Quit on Linux. Misses buildResources. | Highest: exact paths, fixture rows, negative inputs, unit-tested infra (update feed, process probe) for CI-only e2e. | 16 tasks, mostly well sized. t-7 (shared reader) is an optional refactor. | Green per commit. Gitleaks plus deps is the only wave-1 task, everything else depends on it. 6 waves. |

**Skeleton: verification.** It has the sharpest contracts, and it builds unit-tested infrastructure under every CI-only e2e. Its task boundaries map cleanly onto commits that stay green on their own. The risk draft's bugs are grafted in, because they correct verification's two wrong behaviours: the rc channel and Linux restart. mvp's buildResources finding is grafted in too. I merged it down to 14 tasks: server cwd plus main wiring became one main.ts commit, release env joined the tag gate, and builder config joined the package CLI.

## Merged plan

```
Phase 05-release — 14 tasks across 6 waves

Wave 1
  t-1  Allowlist phase tests and add packaging dependencies      [verification+risk]
       depends:  —
       files:    .gitleaks.toml, package.json, pnpm-lock.yaml, pnpm-workspace.yaml,
                 scripts/build-desktop.spec.ts
       covers:   c-1, c-2, c-5
       desc:     The only wave-1 task (vitest is red until the gitleaks entry lands). tests.json allowlist
                 gains ^\.dross/phases/05-release/tests\.json$. electron-updater (exact x.y.z) goes in
                 dependencies; electron-builder and @electron/asar (exact) go in devDependencies.
                 pnpm-workspace.yaml gains supportedArchitectures {os:[current], cpu:[current, x64, arm64],
                 libc:[current]}; onlyBuiltDependencies unchanged. Lockfile regenerated; executor observes
                 `pnpm install --frozen-lockfile` clean before commit.
       contract: - if .gitleaks.toml lacks the exact anchored ^\.dross/phases/05-release/tests\.json$ path,
                   gitleaks-config.spec 'every phase allowlisted' fails (red on this branch today)
                 - if electron-updater is not an exact x.y.z in `dependencies` (a devDependency is left out
                   of the packaged node_modules and the packaged main.js dies on its bare import),
                   build-desktop.spec 'packaging toolchain' fails
                 - if electron-builder or @electron/asar is not an exact x.y.z devDependency,
                   build-desktop.spec 'packaging toolchain' fails
                 - if onlyBuiltDependencies gains anything beyond electron and esbuild, the existing
                   build-desktop.spec 'allows install scripts for exactly electron and esbuild' fails
                 - if pnpm-workspace.yaml supportedArchitectures.cpu lacks x64 or arm64, or libc widens to
                   musl, build-desktop.spec fails
                 - on a darwin host, if @libsql/darwin-arm64/package.json or @libsql/darwin-x64/package.json
                   cannot be resolved from libsql's own directory, build-desktop.spec 'both darwin libsql
                   binaries installed' fails (the universal app would ship one arch); skipped off darwin

Wave 2 (each depends t-1)
  t-2  Write electron-builder config and package CLI             [verification+risk+mvp]
       depends:  t-1
       files:    scripts/package-desktop.ts, scripts/package-desktop.spec.ts, package.json, .gitignore
       covers:   c-1, c-2, c-3, c-4, c-5
       desc:     Pure builderConfig({version, feedUrl?, sign}) -> electron-builder Configuration (type-only
                 import), plus exported PRODUCT_NAME and artifactName patterns. packageDesktop() runs
                 electron-builder's build() (injected in tests) for the host OS only, with publish 'never'.
                 CLI `pnpm package:desktop --version <v> [--feed-url <loopback>] [--sign] [--out <dir>]`
                 refuses when build/handler.js or dist-desktop/main.js is missing. Unsigned runs set
                 CSC_IDENTITY_AUTO_DISCOVERY=false. --sign on darwin refuses unless CSC_LINK,
                 CSC_KEY_PASSWORD, APPLE_API_KEY (an existing non-empty file), APPLE_API_KEY_ID and
                 APPLE_API_ISSUER are set, naming only the missing ones. directories.buildResources is moved
                 off 'build'. Output /dist-packaged is gitignored. Executor observes
                 `pnpm package:desktop --version 0.1.4` produce dist-packaged/mac-universal/<PRODUCT_NAME>.app
                 locally before committing.
       contract: - if builderConfig().appId !== APP_ID, or package-desktop.ts source contains the literal
                   'io.github.rivil.price-check' (must be imported, decision artefacts), package-desktop.spec
                   fails (c-3 AUMID drift)
                 - if mac.target is not exactly dmg and zip each with arch ['universal'], or any mac target
                   names arm64 or x64, package-desktop.spec fails (c-2)
                 - if mac.x64ArchFiles does not match both
                   …/app.asar.unpacked/node_modules/@libsql/darwin-x64/index.node and the darwin-arm64 one, or
                   does match a path under Contents/Frameworks (too broad, hides a missing lipo),
                   package-desktop.spec fails
                 - if win.target is not exactly [{target:'nsis', arch:['x64']}], or nsis.oneClick !== true, or
                   nsis.perMachine !== false (a UAC prompt), package-desktop.spec fails (c-3)
                 - if linux.target is not exactly [{target:'AppImage', arch:['x64']}] (deb/rpm/snap are a
                   milestone non-goal), or any linux executableArgs contains '--no-sandbox',
                   package-desktop.spec fails
                 - if asar !== true, or asarUnpack does not match node_modules/libsql/index.js,
                   node_modules/@libsql/linux-x64-gnu/index.node, node_modules/@libsql/win32-x64-msvc/index.node,
                   both darwin index.node paths and drizzle/0000_little_dreaming_celestial.sql, or
                   npmRebuild !== false, package-desktop.spec fails (c-1 libsql outside asar, never rebuilt)
                 - if directories.buildResources is 'build' or unset (electron-builder never packs its
                   buildResources dir, which would drop adapter-node's build/handler.js), package-desktop.spec
                   fails
                 - if the files patterns (applied in order, negations included) leave out dist-desktop/main.js,
                   build/handler.js, src/desktop/assets/tray-iconTemplate.png or drizzle/meta/_journal.json,
                   or take in local.db, any *.db, .env, src/desktop/main.ts, src/lib/**, e2e/desktop/launch.ts,
                   .dross/**, scripts/** or test-results/x, package-desktop.spec fails
                 - if any artifactName expansion for any target contains whitespace (GitHub renames
                   'Price Check' assets to 'Price.Check' and latest*.yml then 404s), package-desktop.spec fails
                 - if detectUpdateChannel !== false (an rc build would write rc*.yml instead of the latest*.yml
                   c-4 publishes, and rc installs would poll rc.yml), package-desktop.spec fails
                 - if no feedUrl does not give publish [{provider:'github', owner:'Rivil', repo:'price-check'}],
                   or feedUrl 'http://127.0.0.1:47811/' does not give [{provider:'generic', url}], or
                   'https://example.com/' or 'http://10.0.0.1/' does not throw (only a loopback test feed may
                   be baked in, decision update_flow), or sign:true accepts any feedUrl, package-desktop.spec
                   fails
                 - if extraMetadata.version is not the given version for '0.1.5' and '0.1.5-rc.1', or '0.1',
                   'v0.1.5', '0.1.5-rc', 'latest' or '' does not throw, package-desktop.spec fails (c-4 stamping)
                 - if sign:false does not give mac.identity === null, mac.notarize false and env
                   CSC_IDENTITY_AUTO_DISCOVERY === 'false', or sign:true does not give mac.notarize === true
                   and hardenedRuntime === true, or win has any certificate*, signtool* or azureSign* key in
                   either mode, package-desktop.spec fails
                 - if a --sign run with any of the five variables missing or blank, or APPLE_API_KEY naming a
                   missing or empty file, reaches build(), package-desktop.spec fails (c-4 "missing Apple
                   credential publishes nothing")
                 - if stdout or stderr of a refused --sign run contains any sentinel value seeded in the five
                   variables, package-desktop.spec fails (names only, never values)
                 - if build() is ever called with publish other than 'never', or for an OS other than the host
                   ('--win' on darwin accepted), or with build/handler.js or dist-desktop/main.js missing,
                   package-desktop.spec fails
                 - if .gitignore lacks /dist-packaged, or the package:desktop script is not
                   'node scripts/package-desktop.ts', package-desktop.spec fails

  t-3  Gate release tags and create release environment          [risk+verification+mvp]
       depends:  t-1
       files:    scripts/release-tag.ts, scripts/release-tag.spec.ts, .github/environments/release.json,
                 scripts/environments.spec.ts
       covers:   c-2, c-4
       desc:     release-tag.ts (Node built-ins only, type stripping, so the tag job runs no dependency code)
                 exports checkReleaseTag({ref, packageVersion, onMain}) -> {ok, version, prerelease} | {ok:false,
                 reason}, and isOnMain(sha, cwd) via `git merge-base --is-ancestor <sha> origin/main`. Its CLI
                 writes version= and prerelease= to $GITHUB_OUTPUT only on success. release.json holds the
                 environment as applied: deployment_branch_policy {protected_branches:false,
                 custom_branch_policies:true} and policies [{name:'v*', type:'tag'}], no reviewers, no
                 secrets. The executor applies it with `gh api -X PUT repos/Rivil/price-check/environments/release`
                 plus the deployment-branch-policies POST, then reads it back. No secret value is set.
       contract: - if refs/tags/v0.1.5 with package 0.1.5 on main does not give {version:'0.1.5',
                   prerelease:false}, or v0.1.5-rc.2 does not give {version:'0.1.5-rc.2', prerelease:true},
                   release-tag.spec fails
                 - if any of v0.1.6 (vs 0.1.5), v0.1.5 with onMain false, '', 'v', v0.1.5-beta.1, v0.1.5-rc,
                   v0.1.5-rc.0, v0.1.5-rc.01, v0.1.5.0, v0.1.5+b1, 'v0.1.5\n', v01.1.5, 0.1.5 (no v) or
                   refs/heads/v0.1.5 is accepted, release-tag.spec's refusal table fails (edge: empty)
                 - if a version-mismatch refusal's reason omits either version, release-tag.spec fails
                 - if isOnMain is true for a commit reachable only from a side branch, or false for an older
                   commit on main (temp git repo fixture with an origin/main ref), release-tag.spec fails
                 - if the CLI writes anything to $GITHUB_OUTPUT or exits 0 for a refused tag or a non-zero
                   ancestor check, release-tag.spec fails (a later job must never read a half-set output)
                 - if release.json's custom_branch_policies is not true, protected_branches is not false, or
                   policies is not exactly [{name:'v*', type:'tag'}] (a branch-type 'v*' would let a branch
                   named v1 read the signing secrets), environments.spec fails
                 - if release.json has any key matching /secret|CSC_|APPLE_/i, environments.spec fails
                 - executor observes `gh api repos/Rivil/price-check/environments/release/deployment-branch-policies`
                   returning exactly one policy {name:'v*', type:'tag'} before committing (output in the task log)

  t-4  Build update controller and prove rc channels             [risk+verification+mvp]
       depends:  t-1
       files:    src/desktop/updater.ts, src/desktop/updater.spec.ts, src/desktop/updater-channel.spec.ts
       covers:   c-5
       desc:     createUpdater({autoUpdater, isPackaged, appVersion, notifier, onReady, timers, log}) over a
                 structural AutoUpdater type (electron / electron-updater as import type only). Inert unless
                 packaged. Packaged: autoDownload true, autoInstallOnAppQuit false (the lifecycle installs),
                 allowDowngrade false, allowPrerelease false; 'error' is attached before the first check.
                 Checks at start and every 6 h (UPDATE_CHECK_INTERVAL_MS), skipping one while a check is in
                 flight. On update-downloaded it notifies once per version and calls onReady. Returns start(),
                 stop(), status(), pending() and installOnExit('quit'|'restart'). publishUpdaterHandle({status,
                 restart}) sets Symbol.for('price-check.updater') for the packaged e2e. updater-channel.spec
                 drives electron-updater's real GitHubProvider (deep import if the package index pulls in
                 electron) against a local http fake serving releases.atom, /releases/latest and latest.yml.
                 No network.
       contract: - if an unpackaged updater calls checkForUpdates, touches autoUpdater or schedules any timer,
                   updater.spec fails
                 - if start() does not set autoDownload true, autoInstallOnAppQuit false, allowDowngrade false
                   and allowPrerelease false for both '0.1.5' and '0.1.5-rc.1' (the library's own default
                   turns prerelease on for an rc version), updater.spec fails
                 - if 'error' has no listener when the first check starts, or a rejecting checkForUpdates or an
                   'error' event throws, leaves an unhandled rejection or stops the next 6 h check,
                   updater.spec fails
                 - if checkForUpdates is not called once at start, again at exactly 6 h (none at 6 h - 1 ms) and
                   4 times by 18 h, or a check starts while one is pending, or one runs after stop(),
                   updater.spec fails (fake timers)
                 - if 'update-downloaded' {version:'0.1.6'} does not give exactly one notifier show (body names
                   0.1.6 and 'Restart to update') and one onReady('0.1.6'), or a re-emitted 0.1.6 shows again,
                   or a later 0.1.7 does not show, updater.spec fails
                 - if 48 h of fake timers after a download produce any quitAndInstall call (a forced restart),
                   updater.spec fails
                 - if installOnExit('quit') with nothing downloaded calls quitAndInstall, or with a download does
                   not call quitAndInstall(true, false) once, or installOnExit('restart') does not call
                   quitAndInstall(true, true), or a throwing quitAndInstall propagates, updater.spec fails
                 - if status() is not 'idle' -> 'checking' -> 'downloaded' with version 0.1.6 across the events,
                   or the handle's symbol is not Symbol.for('price-check.updater'), updater.spec fails
                 - if updater.ts (source ?raw) contains setFeedURL, forceDevUpdateConfig, updateConfigPath, a
                   provider/url assignment, or a value import of electron or electron-updater, updater.spec
                   fails (decision update_flow: no runtime feed override)
                 - if the real GitHubProvider, current 0.1.5-rc.1 configured as createUpdater sets it, feed
                   {v0.1.5 latest, v0.1.5-rc.1 prerelease}, does not resolve 0.1.5, updater-channel.spec
                   'rc takes final' fails
                 - if the real GitHubProvider, current 0.1.5, feed {v0.1.6-rc.1 prerelease, v0.1.5 latest},
                   resolves anything newer than 0.1.5, updater-channel.spec 'final never takes rc' fails
                 - if the fake server sees any request for rc.yml / rc-*.yml, updater-channel.spec fails (pairs
                   with t-2's detectUpdateChannel false)

  t-5  Install updates after shutdown; add tray restart item     [verification+risk+mvp]
       depends:  t-1
       files:    src/desktop/lifecycle.ts, src/desktop/lifecycle.spec.ts, src/desktop/tray.ts,
                 src/desktop/tray.spec.ts
       covers:   c-5, c-6
       desc:     LifecycleDeps gains optional updates {pending(), installOnExit(mode)} (absent means
                 unpackaged: nothing installs, and main.ts still compiles unchanged), predecessorPid
                 (number | null) and isProcessAlive(pid). LifecycleTrayActions/TrayActions gain
                 restartToUpdate(), which sets mode 'restart' and calls app.quit(). Quit runs scheduler stop,
                 server close and DB close (or hits the deadline). Then, if pending, it sets
                 process.env.PRICE_CHECK_PREDECESSOR_PID to its own pid, calls installOnExit(mode), then
                 app.exit(0). A before-quit re-entered after the install is passed over and never hangs
                 the exit. Startup: a lost lock with predecessorPid set polls isProcessAlive until it is false
                 (cap 30 s), then retries the lock once before quitting as 'second-instance'. TrayHandle gains
                 setUpdateReady(bool), which adds 'Restart to update' above Quit. Executor also runs pnpm check.
       contract: - if Quit with an update pending does not log exactly [stop, closeServer, closeDb, install:quit,
                   exit:0] in lifecycle.spec's call-order log, lifecycle.spec fails (Quit installs; the
                   installer starts only after the DB is closed, c-6)
                 - if restartToUpdate() does not log [..., closeDb, install:restart, exit:0], calls app.quit()
                   other than once, or a second restartToUpdate while quitting changes anything,
                   lifecycle.spec fails
                 - if a quit with pending() false calls install, or deps without updates (unpackaged) changes
                   the existing quit order, lifecycle.spec fails
                 - if closeDb hangs and install runs before SHUTDOWN_DEADLINE_MS elapses, or never runs after
                   it, lifecycle.spec fails (fake timers)
                 - if a throwing installOnExit stops app.exit(0), or install runs twice across two quits,
                   lifecycle.spec fails
                 - if a before-quit fired by install's own app.quit() leaves the process without app.exit(0)
                   (the hang), lifecycle.spec fails
                 - if installOnExit is called without process.env.PRICE_CHECK_PREDECESSOR_PID equal to the
                   running pid, lifecycle.spec fails
                 - if any path calls app.relaunch() (the only relaunch is the updater's, after this process
                   exits), lifecycle.spec fails
                 - if a lost lock with predecessorPid set quits before isProcessAlive returns false, takes the
                   lock and starts while it is still true, or waits past 30 s, lifecycle.spec fails; with
                   predecessorPid null a lost lock quits at once (the existing second-instance tests keep
                   passing)
                 - if the tray menu before setUpdateReady(true) is not exactly Open, Start at login, separator,
                   Quit, or after it lacks exactly one 'Restart to update' item above Quit whose click calls
                   restartToUpdate once, or a second setUpdateReady(true) adds a second item, tray.spec fails

  t-6  Document per-OS install and AppImage prerequisites        [risk+verification+mvp]
       depends:  t-1
       files:    README.md, scripts/readme.spec.ts
       covers:   c-1
       desc:     "Install and use" gains per-OS detail for end users: macOS (one dmg for Apple silicon and
                 Intel), Windows (installer, SmartScreen only, no admin rights), Linux AppImage (libfuse2,
                 libfuse2t64 on Ubuntu 24.04+, and the Ubuntu 24.04+ AppArmor step that keeps the sandbox).
                 Drops the "Not released yet" note. Names no pnpm script that does not exist.
       contract: - if the install section's Linux part lacks 'libfuse2' or the AppArmor step
                   (apparmor_restrict_unprivileged_userns or an AppArmor profile instruction), readme.spec
                   'Linux run notes' fails (decision artefacts)
                 - if README anywhere suggests '--no-sandbox' or 'APPIMAGE_EXTRACT_AND_RUN' to users,
                   readme.spec fails (the AppImage keeps the Chromium sandbox)
                 - if the macOS part does not say one download serves both Apple silicon and Intel, or the
                   Windows part does not say no administrator rights are needed, readme.spec fails
                 - if the 'Not released yet' note survives, readme.spec fails
                 - if README names a `pnpm <x>` that is not a package.json script, the existing readme.spec
                   pnpmCommands check fails

  t-7  Extract shared workflow line reader                       [verification]
       depends:  t-1
       files:    scripts/workflow-reader.ts, scripts/workflow-reader.spec.ts, scripts/ci-desktop.spec.ts
       covers:   c-1, c-4
       desc:     Moves ci-desktop.spec's job/block/map/steps/branches helpers into readWorkflow(text), still
                 with no YAML library. It adds `on` triggers and the job keys release-workflow.spec and
                 ci-packaged.spec need (needs, permissions, environment, runs-on, if, concurrency).
                 ci-desktop.spec switches to the shared reader and keeps its assertions.
       contract: - if readWorkflow(text).job('missing') returns an empty body instead of throwing an error
                   naming 'missing', workflow-reader.spec fails
                 - if a step after a `run: |` block scalar is merged into it, or step.get('uses') and step.run
                   miss a `- uses:` step with `with:`, workflow-reader.spec's fixture fails
                 - if jobKey('needs') does not read both `needs: [a, b]` and a block list as ['a','b'], or
                   triggers() does not read push.tags ['v*'], workflow-reader.spec fails
                 - if the shared steps()/branches() lose the desktop step's Linux branch, ci-desktop.spec 'runs
                   Linux under xvfb-run -a, after the AppArmor userns sysctl' fails

  t-8  Add loopback update feed and process probe                [verification+risk]
       depends:  t-1
       files:    scripts/update-feed.ts, scripts/update-feed.spec.ts, scripts/process-probe.ts,
                 scripts/process-probe.spec.ts
       covers:   c-5, c-6
       desc:     UPDATE_FEED_PORT constant. startUpdateFeed({dir, port}) is a node:http server on 127.0.0.1
                 only. It serves regular files directly in dir (with Range) and records requested paths.
                 process-probe parses Get-Process / Get-CimInstance ConvertTo-Json output and `ss -Hltnp` lines
                 into {pid, path, startTime} and a pid -> port map.
       contract: - if GET /latest.yml does not return the file's bytes, or /../package.json,
                   /%2e%2e/package.json or /sub/x return anything but 404, update-feed.spec fails
                 - if the server's address is not 127.0.0.1, or a busy port resolves on another port instead of
                   rejecting (the URL is baked into build A), update-feed.spec fails
                 - if `Range: bytes=0-9` does not give 206 with exactly 10 bytes (electron-updater's blockmap
                   download), update-feed.spec fails
                 - if requests() does not list '/latest.yml' after it was fetched, update-feed.spec fails
                 - if a single Get-Process object (ConvertTo-Json emits no array for one) is not read as one
                   process, or a '/Date(1731600000000)/' StartTime is not that instant, process-probe.spec fails
                 - if the ss line `LISTEN 0 511 127.0.0.1:40123 0.0.0.0:* users:(("price-check",pid=4242,fd=33))`
                   does not map 4242 -> 40123, or another pid's or a [::] listener is taken, process-probe.spec
                   fails

Wave 3
  t-9  Locate, install and verify packaged artefacts             [verification+risk]
       depends:  t-2
       files:    scripts/packaged-app.ts, scripts/packaged-app.spec.ts, scripts/verify-packaged.ts,
                 scripts/verify-packaged.spec.ts
       covers:   c-1, c-2, c-3, c-4
       desc:     packaged-app.ts: expectedArtefacts(platform, version) from t-2's patterns; locate(outDir),
                 which refuses single-arch mac dirs and more than one AppImage; executablePath per OS;
                 packagedUserDataDir(platform, env, home) from APP_DIR_NAME; installWindows(installer) runs
                 '<installer> /S' and reads InstallLocation from the HKCU Uninstall key; CLI `exe` prints the
                 path for PRICE_CHECK_PACKAGED_EXE. verify-packaged.ts (runner injected, commands from pure
                 builders, exit 1 listing every violation):
                 `mac <app> [--signed]`: lipo, both darwin libsql unpacked, and with --signed codesign,
                 spctl and stapler.
                 `win`: per-user install, plus the Start Menu .lnk's System.AppUserModel.ID === APP_ID.
                 `layout <outDir>` (every OS): asar listing via @electron/asar shows no .node and no dev files;
                 the per-OS @libsql set is unpacked; the packaged package.json version and latest*.yml match
                 the stamped version, with files[].url present and sha512 set; the app-update.yml provider
                 matches the mode.
       contract: - if parseLipoArchs('Non-fat file: x is architecture: arm64') passes verifyMac, or
                   'Architectures in the fat file: x are: x86_64 arm64' fails it, verify-packaged.spec fails (c-2)
                 - if a fake app tree missing app.asar.unpacked/…/@libsql/darwin-x64/index.node (or the
                   darwin-arm64 one) passes verifyMac, verify-packaged.spec fails
                 - if macCommands({signed:false}) contains codesign, spctl or stapler, or {signed:true} lacks
                   exactly `codesign --verify --deep --strict`, `spctl --assess --type execute` and
                   `xcrun stapler validate` on the app, or a fake runner exiting 1 on any one leaves the CLI at
                   exit 0, verify-packaged.spec fails
                 - if parseAumid returns anything but the exact trimmed value (CRLF, BOM), or a .lnk whose AUMID
                   is missing or is the exe path passes verifyWin, verify-packaged.spec fails (c-3)
                 - if an InstallLocation outside %LOCALAPPDATA%, the uninstall key under HKLM, or an installer
                   manifest whose requestedExecutionLevel is requireAdministrator/highestAvailable passes
                   verifyWin, verify-packaged.spec fails (per-user, no UAC)
                 - if a fixture asar (built with @electron/asar in a temp dir) holding @libsql/*/*.node packed
                   rather than unpacked, or any .db, .env, .dross/, e2e/ or src/lib/ entry, passes verifyLayout,
                   verify-packaged.spec fails
                 - if darwin unpacked lacks darwin-x64 or darwin-arm64, linux ships linux-arm64-gnu or a musl
                   build, or win ships anything but win32-x64-msvc, verify-packaged.spec fails
                 - if the packaged package.json version or a latest*.yml version differs from the stamped one
                   (0.1.5 vs 0.1.5-rc.1), or a files[].url names a file absent from outDir, contains whitespace
                   or lacks sha512, verify-packaged.spec fails (c-4)
                 - if mode 'release' meets app-update.yml provider generic, or mode 'ci' meets github,
                   verify-packaged.spec fails (a release built with the CI feed)
                 - if expectedArtefacts('darwin','0.1.5-rc.1') lacks the dmg, the zip or latest-mac.yml, win32
                   lacks the setup exe or latest.yml, linux lacks the AppImage or latest-linux.yml, or any name
                   contains whitespace, packaged-app.spec fails
                 - if locate() accepts a dir holding mac-arm64/ or two AppImages, or executablePath for darwin
                   is not '<out>/mac-universal/<PRODUCT_NAME>.app/Contents/MacOS/<PRODUCT_NAME>', packaged-app.spec
                   fails
                 - if packagedUserDataDir is not <home>/Library/Application Support/price-check (darwin),
                   <APPDATA>\price-check (win32), or $XDG_CONFIG_HOME/price-check with a <home>/.config fallback
                   (linux), or is built from a literal instead of APP_DIR_NAME, packaged-app.spec fails
                 - if installWindows with a fake installer exiting 2 resolves, or parseRegQuery picks a key whose
                   DisplayName is not PRODUCT_NAME, packaged-app.spec fails

  t-10 Wire packaged server cwd and updater into main            [risk+verification+mvp]
       depends:  t-4, t-5
       files:    src/desktop/app-paths.ts, src/desktop/app-paths.spec.ts, src/desktop/main.ts,
                 src/desktop/boundary.spec.ts, e2e/desktop/harness.e2e.ts
       covers:   c-1, c-5, c-6
       desc:     serverCwdFor(appRoot) maps a root whose last segment is app.asar to its app.asar.unpacked
                 sibling (either separator) and leaves any other root as is. main.ts passes serverCwdFor(APP_ROOT)
                 to loadAdapterHandler; HANDLER_URL and ICON_DIR stay under APP_ROOT. main.ts reads (then
                 deletes) PRICE_CHECK_PREDECESSOR_PID before loadAdapterHandler swaps process.env. It
                 default-imports electron-updater and, only when app.isPackaged, builds the updater with the
                 existing notifier and passes updates/predecessorPid/isProcessAlive to runDesktop. onReady calls
                 the tray's setUpdateReady(true). After 'started' it calls start() and
                 publishUpdaterHandle({status, restart: restartToUpdate}). Executor runs pnpm check and observes
                 pnpm test:e2e:desktop green.
       contract: - if serverCwdFor('/A/Price Check.app/Contents/Resources/app.asar') is not '…/app.asar.unpacked',
                   or the Windows 'C:\…\resources\app.asar' (drive and separators kept) and AppImage
                   '/tmp/.mount_x/resources/app.asar' rows are not mapped the same way, app-paths.spec fails
                 - if '/repo', '/x/app.asar.unpacked', '/x/app.asarx' or '/home/u/x.asar.d/app' is changed,
                   app-paths.spec fails (unpackaged dev and e2e keep the repo root)
                 - if migrationsFolder(serverCwdFor(packagedRoot)) is not '<…>/app.asar.unpacked/drizzle',
                   app-paths.spec fails
                 - if main.ts (source ?raw) still passes APP_ROOT as loadAdapterHandler's cwd argument,
                   app-paths.spec 'main wires serverCwdFor' fails (otherwise the packaged chdir throws ENOTDIR)
                 - if any non-spec src/desktop module other than main.ts value-imports 'electron-updater',
                   boundary.spec fails
                 - if any non-spec src/desktop file mentions setFeedURL, forceDevUpdateConfig or
                   updateConfigPath, boundary.spec 'no runtime feed override' fails
                 - if main.ts reads PRICE_CHECK_PREDECESSOR_PID after the loadAdapterHandler call (source order),
                   boundary.spec fails
                 - if the real-entry bundle stops building or inlines electron-updater, the existing
                   build-desktop.spec 'real entry' / 'leaves other packages as bare imports' fails
                 - if an unpackaged launch has Symbol.for('price-check.updater') defined in main, harness.e2e
                   fails (executor-observed, not vitest-gated)

Wave 4
  t-11 Add packaged smoke e2e and its harness                    [verification+risk+mvp]
       depends:  t-9, t-10
       files:    e2e/packaged/launch-packaged.ts, e2e/packaged/smoke.packaged.ts,
                 playwright.packaged.config.ts, package.json
       covers:   c-1, c-2
       desc:     launchPackaged runs PRICE_CHECK_PACKAGED_EXE through _electron ({executablePath,
                 chromiumSandbox true}) with an allowlisted env. It takes the origin from the first window URL,
                 not stdout. It refuses to start while packagedUserDataDir exists. Afterwards it turns off the
                 login item and removes only the dir its own run created.
                 Launch 1: empty watchlist, plus the libsql sharedObjects check. Quit; seed-child inserts an
                 https://shop.e2e.invalid/… watch (r-01). Launch 2: the watch is listed, and its target is
                 changed through the watch page. Launch 3: the new target shows.
                 darwin also spawns the app under `arch -x86_64` and GETs the watchlist.
                 test:e2e:packaged = 'playwright test --config playwright.packaged.config.ts' (testDir
                 e2e/packaged, testMatch **/*.packaged.ts, workers 1, retries 0, forbidOnly in CI, outputDir
                 test-results/packaged). Executor observes package:desktop + test:e2e:packaged green on macOS
                 locally if no real price-check userData exists there; otherwise the first observation is t-14's
                 PR run, and the task log says so.
       contract: - if launch 1's first window is not http://127.0.0.1:<port>/ showing 'Nothing on your watchlist
                   yet.', or app.isPackaged is false, smoke.packaged 'empty' fails (also catches the ENOTDIR /
                   missing-migrations startup t-10 removes)
                 - if app.getPath('userData') !== packagedUserDataDir(...), smoke.packaged fails (the guard and
                   cleanup would protect the wrong dir)
                 - if process.report.getReport().sharedObjects has no @libsql/<platform>-<arch> .node path under
                   app.asar.unpacked, or has one anywhere else (Electron's temp extraction from inside app.asar),
                   smoke.packaged 'libsql outside asar' fails (c-1)
                 - if after quit + seed + relaunch the 'E2E Packaged Kettle' card is missing, or after the target
                   change + relaunch the card does not show £12.34, smoke.packaged 'persists' fails
                 - on darwin, if the `arch -x86_64` launch does not serve the seeded watch (x64 slice or
                   darwin-x64 binary missing), smoke.packaged 'x64 slice' fails (c-2)
                 - if the CI build's unreachable loopback feed makes the app exit or the window error within
                   15 s of launch, smoke.packaged 'offline update check' fails
                 - if launchPackaged with packagedUserDataDir already present spawns any process instead of
                   rejecting, smoke.packaged 'refuses existing data' fails
                 - if the web or desktop Playwright config collects any e2e/packaged file, or the packaged config
                   collects anything outside e2e/packaged, t-14's ci-packaged.spec fails (pinned there; the
                   *.packaged.ts suffix is what keeps them apart)

Wave 5
  t-12 Prove update install on Windows and Linux                 [verification+risk+mvp]
       depends:  t-8, t-11
       files:    e2e/packaged/update.packaged.ts, e2e/packaged/launch-packaged.ts
       covers:   c-5, c-6
       desc:     Runs when PRICE_CHECK_UPDATE_FEED_DIR is set; skipped on darwin (device UAT). Build A is the
                 package.json version with --feed-url http://127.0.0.1:UPDATE_FEED_PORT/ (also the PR smoke
                 build); build B is the next patch. Seed a watch into A, start the feed over B, launch A and wait
                 for status() 'downloaded' B.
                 Windows: handle.restart(), then probe the relaunched process.
                 Linux: Quit via app.close(), relaunch, and check B. Then re-copy A's AppImage and prove
                 handle.restart() through the predecessor wait.
                 Both: a Playwright relaunch shows getVersion B and the watch.
       contract: - if the feed records no GET of latest.yml (win) / latest-linux.yml (linux) during the launch,
                   update.packaged fails (check at launch)
                 - if status() does not reach 'downloaded' with version B within 180 s, or A's process exits on
                   its own within 30 s after that (a forced restart), update.packaged fails
                 - if the updater state lists B as notified other than exactly once after a second forced
                   check, update.packaged fails (one notification per version)
                 - Windows: if the relaunched process (by install path) has a StartTime not after A's observed
                   exit, or GET / on its listening port lacks the seeded watch title, update.packaged 'relaunch
                   after exit' fails (c-6)
                 - if the relaunched app's getVersion() !== B, the seeded watch is missing, `PRAGMA
                   integrity_check` via seed-child is not 'ok', or the log shows 'database is locked',
                   update.packaged fails
                 - Linux: if after Quit the AppImage at the original path is not B (the updater replaced
                   another file), or after Restart no B process is running within 30 s (the relaunch lost the
                   single-instance lock), update.packaged fails
                 - not runnable on the macOS host: observed green in t-14's PR run on test (windows) and
                   test (linux)

  t-13 Add tag-triggered release workflow and write allowlist    [risk+verification+mvp]
       depends:  t-3, t-7, t-9, t-11
       files:    .github/workflows/release.yml, scripts/workflow-policy.ts, scripts/workflow-policy.spec.ts,
                 scripts/release-workflow.spec.ts
       covers:   c-1, c-2, c-4
       desc:     Executor first reads ~/.claude/memory/reference_ci_supply_chain_hardening.md.
                 Trigger: push tags 'v*', with a per-ref concurrency group and cancel-in-progress false.
                 Job tag (contents: read): checkout fetch-depth 0, no install; runs release-tag.ts; outputs
                 version and prerelease.
                 Three build jobs (macos-15 / windows-2025 / ubuntu-24.04, contents: read, no cache): frozen
                 install, vite build + build-desktop, package --version from tag, verify-packaged layout, then
                 the packaged smoke. Windows smoke runs after the silent install + verify win. Linux runs
                 under xvfb-run -a after the userns sysctl.
                 The mac job alone takes environment: release. Its package step alone reads the five secrets,
                 decodes the p8 to $RUNNER_TEMP/AuthKey.p8, sets APPLE_API_KEY and passes --sign. Then
                 `verify-packaged.ts mac <app> --signed` runs, then upload-artifact.
                 Job publish (needs all four, only contents: write, no checkout, gh only): download artefacts,
                 check the file set against expectedArtefacts, refuse if any release (drafts included) exists
                 for the tag, then one `gh release create --verify-tag` with every file.
                 WRITE_SCOPE_ALLOWLIST = { 'release.yml': ['contents'] }.
       contract: - if WRITE_SCOPE_ALLOWLIST is not deep-equal { 'release.yml': ['contents'] },
                   workflow-policy.spec 'allowlist' fails (replaces 'ships empty'); if the same job-level
                   contents: write in ci.yml, packages: write in release.yml, or workflow-level contents: write in
                   release.yml is not reported, workflow-policy.spec fails
                 - if any job other than publish has a permission other than contents: read, or publish has more
                   than contents: write, release-workflow.spec fails (the allowlist is per file, not per job)
                 - if release.yml triggers on anything but push tags ['v*'], or lacks a per-ref concurrency
                   group with cancel-in-progress false, release-workflow.spec fails
                 - if any job uses actions/cache, any setup-node has `cache:`, any pnpm install lacks
                   --frozen-lockfile, or any checkout lacks persist-credentials: false, release-workflow.spec
                   fails
                 - if `secrets.` appears outside the mac package step's env or inside any `run:` body, that env
                   is not exactly the five named secrets, or `environment: release` is on any job but the mac
                   build (or its name differs from .github/environments/release.json), release-workflow.spec
                   fails
                 - if the mac build lacks --sign, or lacks `verify-packaged.ts mac <app> --signed` between package
                   and upload, or Windows/Linux pass --sign or any --feed-url, or any build lacks verify-packaged
                   layout and test:e2e:packaged before its upload-artifact step, release-workflow.spec fails
                   (c-1 on release artefacts, c-2 before publishing)
                 - if ci.yml contains codesign, spctl or stapler, release-workflow.spec fails (PR CI never
                   checks signing)
                 - if publish.needs is not exactly [tag, build-macos, build-windows, build-linux], or any job has
                   `if: always()` / `if: ${{ !cancelled() }}` / failure(), release-workflow.spec fails (c-4 any
                   failed build publishes nothing)
                 - if publish has a checkout, setup-node, any `uses:` other than download-artifact, or a run line
                   invoking node, pnpm, npm or npx, release-workflow.spec fails (writer runs no repo or
                   dependency code)
                 - if publish's required-file list is not the union of expectedArtefacts for darwin, win32 and
                   linux, or the existence check does not list releases including drafts before the single
                   `gh release create`, or create lacks --verify-tag or --repo "$GITHUB_REPOSITORY", or
                   --prerelease is not tied to needs.tag.outputs.prerelease, release-workflow.spec fails
                 - running publish's extracted run block under bash with a stub gh on PATH (skipped on win32): an
                   existing release or draft for the tag gives no create call and exit 1; an asset list one short
                   gives no create; an rc tag's create carries --prerelease and a final's does not;
                   release-workflow.spec fails on any deviation (c-4 empty and idempotency edges)
                 - executor observes `pnpm ci:policy` exit 0 over the real .github/workflows

Wave 6
  t-14 Package and run packaged suites in PR CI                  [verification+risk+mvp]
       depends:  t-7, t-9, t-11, t-12
       files:    .github/workflows/ci.yml, scripts/ci-packaged.spec.ts
       covers:   c-1, c-2, c-3, c-5, c-6
       desc:     Executor first reads ~/.claude/memory/reference_ci_supply_chain_hardening.md. The steps go
                 inside the existing `test` matrix job, after the desktop e2e, in the same RUNNER_OS
                 shell-branch pattern. No new job, so the check names are unchanged.
                 Package A with CSC_IDENTITY_AUTO_DISCOVERY=false and never --sign. Windows and Linux bake the
                 loopback feed into A. Then verify-packaged layout on every OS.
                 macOS: verify mac (unsigned). Windows: silent install, then verify win. Linux: apt
                 libfuse2t64. Windows and Linux then package B and set PRICE_CHECK_UPDATE_FEED_DIR.
                 Then pnpm test:e2e:packaged (Linux: sysctl, then xvfb-run -a).
                 The failure upload covers test-results/packaged and dist-packaged logs, and the timeout goes
                 up. Executor pushes and observes test (linux|macos|windows) green on the PR.
       contract: - if any matrix OS can skip the package, verify or packaged-e2e step (a step `if:`,
                   continue-on-error, or a branch without it), or they run before the desktop e2e,
                   ci-packaged.spec fails (c-1 every PR, all three OSes)
                 - if a ci.yml package step passes --sign, lacks env CSC_IDENTITY_AUTO_DISCOVERY: 'false', or
                   ci.yml references secrets.* or CSC_LINK, ci-packaged.spec fails (PR builds never sign)
                 - if the macOS branch lacks `verify-packaged.ts mac` or passes --signed, or the Windows branch
                   does not run the silent install before `verify-packaged.ts win`, ci-packaged.spec fails (c-2
                   lipo/libsql, c-3 AUMID and per-user on every PR)
                 - if B is packaged on macOS, or update.packaged runs on macOS, or the --feed-url port differs
                   from UPDATE_FEED_PORT (imported), or PRICE_CHECK_UPDATE_FEED_DIR is unset on windows/linux,
                   ci-packaged.spec fails
                 - if Linux's packaged run is not `xvfb-run -a pnpm test:e2e:packaged` after the userns sysctl
                   and the libfuse2t64 install, or '--no-sandbox' appears in ci.yml or any e2e/packaged/*.ts
                   outside a comment, ci-packaged.spec fails
                 - if playwright.packaged.config's outputDir is not under an uploaded path, or the web/desktop
                   configs collect any e2e/packaged file, or the packaged config collects anything else,
                   ci-packaged.spec fails
                 - if a new job is added instead of steps, rulesets.spec 'ci.yml produces the five gate checks'
                   fails (required checks unchanged)
                 - observed: the PR's test (windows) and test (linux) run t-12's update e2e green, and
                   test (macos) runs verify mac + smoke (incl. x64 slice) green
```

Coverage:

| criterion | tasks |
|---|---|
| c-1 | t-1, t-2, t-6, t-7, t-9, t-10, t-11, t-13, t-14 |
| c-2 | t-1, t-2, t-3, t-9, t-11, t-13, t-14 |
| c-3 | t-2, t-9, t-14 |
| c-4 | t-2, t-3, t-7, t-9, t-13 |
| c-5 | t-1, t-2, t-4, t-5, t-8, t-10, t-12, t-14 |
| c-6 | t-5, t-8, t-10, t-12, t-14 |

Spec edges:
- **empty (c-4):** t-13's file-set refusal and t-3's refusal table.
- **idempotency (c-4):** t-13's existence check (drafts included) plus the per-ref concurrency group.
- **concurrency (c-6):** t-5's install-after-closeDb and predecessor wait, plus t-12's StartTime-after-exit check.

Device-UAT parts are not tasks: Gatekeeper open, SmartScreen, toast display, Send test + click on packaged builds, and the macOS update.

## Disagreements

**D1. Packaged server cwd.**
- Risk and verification: chdir to `app.asar.unpacked`, with `drizzle/**` asarUnpack'd and a pure path function.
- mvp: chdir to `process.resourcesPath`, with drizzle as an extraResource.
- **Default:** app.asar.unpacked (t-10, t-2).
- **Why it matters:** both avoid the ENOTDIR crash. resourcesPath puts drizzle outside the asar tree that verify-packaged inspects. app.asar.unpacked keeps one unpack rule and a unit-testable mapping, but it only exists because something is unpacked. libsql guarantees that.

**D2. allowPrerelease for an rc install.**
- Risk: always false, plus detectUpdateChannel false, proved against the real GitHubProvider.
- mvp and verification: true when the version has -rc.N. verification pins it in a contract; mvp's own provider contract contradicts it.
- **Default:** risk's (t-4). If the real-provider spec shows the library behaves otherwise, the behaviour contracts ('rc takes final', 'final never takes rc') win over the flag pin. The executor adjusts the flag contract and records why.
- **Why it matters:** get this wrong and the rc-to-final device UAT fails, or every final install pulls rcs.

**D3. How install-on-exit is invoked.**
- Risk: one install() = quitAndInstall(true, true) for both Quit and Restart. It lets the library's re-entrant app.quit() pass through, with a 5 s exit fallback.
- mvp and verification: installOnExit(mode), where Quit is (true, false) and Restart is (true, true), then app.exit(0) at once.
- **Default:** verification's modes with an immediate app.exit(0), keeping risk's "re-entry never hangs" and "install after deadline" contracts (t-4, t-5).
- **Why it matters:** risk's version relaunches the app after a user's Quit. Waiting on the library's own quit risks the hang risk found.

**D4. Predecessor-pid wait on a lost single-instance lock.**
- Risk: needed, because an AppImage Restart spawns the new instance before the old one exits and it loses the lock.
- mvp and verification: absent. verification avoids it by proving only Quit on Linux.
- **Default:** included for all OSes (t-5, t-10), and Linux CI proves Restart too (t-12).
- **Why it matters:** without it, "Restart to update" on Linux closes the app and never brings it back. That is a day-one device-UAT failure for c-5.

**D5. Guard against a packaged run touching real userData.**
- Risk: refuse unless CI === 'true'.
- mvp: refuse unless a harness marker file exists.
- verification: refuse if the per-OS userData dir exists, and remove only what the run created.
- **Default:** verification's (t-11).
- **Why it matters:** risk's version never lets the executor observe the smoke locally. mvp's marker trusts a file the test itself writes. verification's version is safe on any host but refuses on a dev machine that already has a price-check dir from `pnpm dev:desktop`. In that case the first observed run is the PR, and the task log must say so.

**D6. Missing-Apple-credential gate placement.**
- Risk: in the package CLI's --sign path. It checks the five electron-builder variables, APPLE_API_KEY must be a non-empty file, and a sentinel no-echo test covers the output.
- verification: release-tag.ts `apple-credentials` over the five secret names, before the p8 is decoded.
- mvp: a workflow step that fails on an empty secret.
- **Default:** risk's, in t-2.
- **Why it matters:** it gates build() itself. An empty base64 secret decodes to an empty file, which this check catches. The workflow cannot bypass it by reordering steps.

**D7. Where WRITE_SCOPE_ALLOWLIST changes.**
- mvp: with the tag gate, in wave 2.
- Risk and verification: in the same commit as release.yml.
- **Default:** with release.yml (t-13).
- **Why it matters:** the allowlist is per file. Granting it before the file exists leaves a window with no test pinning the build jobs to read-only.

**D8. Publish mechanics.**
- mvp and verification: `gh release view` the tag, exit if it exists, then one `gh release create`.
- Risk: list releases including drafts, create as a draft, then undraft. Risk also adds blockmaps to the expected asset set.
- **Default:** one `gh release create --verify-tag` (the locked "every file at once"), with risk's drafts-included existence check (t-13). expectedArtefacts covers c-4's named files; whether blockmaps join the required set is left to t-9's implementer, but any blockmap present is published.
- **Why it matters:** a failed mid-upload run leaves a draft. `gh release view <tag>` does not see drafts, so a re-run would create a second release.

**D9. Which update path each OS proves in CI.**
- verification: Windows Restart, Linux Quit.
- Risk: Quit on both.
- mvp: both paths on both OSes.
- **Default:** Windows Restart (c-6 needs the installer's relaunch); Linux Quit and then Restart, because re-copying an AppImage is cheap (t-12).
- **Why it matters:** c-5 says "Restart or Quit installs" and is CI-proved only on Windows/Linux. D4's race only shows on a Linux Restart.

**D10. FUSE on the Linux CI runner.**
- mvp and verification: `apt-get install libfuse2t64`.
- Risk: APPIMAGE_EXTRACT_AND_RUN=1 in CI only, rejecting an unpinned apt install.
- **Default:** apt libfuse2t64 (t-14). It runs the AppImage the way the README tells users to.
- **Why it matters:** extract-and-run skips the FUSE mount path users hit and may change the APPIMAGE path the updater replaces. apt adds an unpinned distro package to the job, which the supply-chain checklist should weigh.

**D11. Keeping packaged specs out of the other suites.**
- mvp and verification: a `*.packaged.ts` suffix that neither existing config matches.
- Risk: `e2e/packaged/*.e2e.ts` plus a testIgnore edit to playwright.config.ts.
- **Default:** the suffix (t-11), pinned in ci-packaged.spec (t-14).
- **Why it matters:** the web config's `**/*.e2e.{ts,js}` would otherwise run packaged specs against the preview server.

**D12. What "saves a watch" means in the smoke.**
- mvp and verification: seed via seed-child, then retarget through the app's watch page, then relaunch.
- Risk: seed, then relaunch twice.
- **Default:** UI retarget (t-11).
- **Why it matters:** only a write through the packaged app proves packaged libsql writes persist. Adding through the UI is ruled out by r-01.

**D13. Shared workflow reader refactor.**
- verification: a separate task, so release-workflow.spec and ci-packaged.spec read needs/environment/triggers reliably.
- Risk and mvp: write each spec's parsing inline.
- **Default:** kept (t-7).
- **Why it matters:** it adds a task and touches a passing spec, but three ad-hoc line parsers for the job keys c-4's safety rests on is the larger risk.

**D14. Windows c-3 check: how and where.**
- Risk and mvp: read the Start Menu .lnk's System.AppUserModel.ID. Risk adds a separate windows-install.e2e and a manifest executionLevel parse.
- verification: Get-StartApps AppID, run as a verify-packaged CLI.
- **Default:** a verify-packaged CLI reading the .lnk property, plus risk's manifest/HKCU parsers, with no extra e2e file (t-9, t-14).
- **Why it matters:** c-3 names the shortcut's AUMID. Get-StartApps can surface the exe path for a shortcut with no AUMID, which verification's own contract guards against.

**D15. Rosetta launch of the universal app's x64 slice.**
- Risk: needed.
- mvp and verification: absent (lipo only).
- **Default:** included in the darwin smoke (t-11).
- **Why it matters:** lipo proves two slices exist, not that the x64 one runs with darwin-x64 libsql. It fails loudly if the macos-15 runner lacks Rosetta.

**D16. Task shape.**
- Risk: builder config and package CLI as two tasks.
- verification and mvp: one task.
- Risk: verify-package (asar/latest.yml) separate from Windows install checks.
- verification: locate/install merged with mac/win verify.
- Output dir: /dist (verification), dist-packaged/ (mvp), release/ (risk).
- **Default:** one config+CLI task (t-2); one packaged-app+verify task absorbing risk's layout checks (t-9, hence @electron/asar in t-1); /dist-packaged.
- **Why it matters:** this is mostly granularity. The asar-content check needs a new exact-pinned devDependency, which is the cost of risk's "dev files shipped" coverage.

**D17. Wave-1 pairing for the gitleaks entry.**
- verification: with deps.
- Risk: with the tag gate.
- mvp: with README.
- **Default:** with deps (t-1), the root of the packaging chain.
- **Why it matters:** this only shapes the critical path; every pairing keeps vitest green.

**D18. README "Not released yet" note.**
- Risk: drop it in this phase.
- mvp and verification: silent.
- **Default:** drop it (t-6).
- **Why it matters:** the tag is cut on the merged main commit, so a note kept here ships inside the very release it denies.

**Unowned observation (not a divergence, no task added).** After loadAdapterHandler, process.env holds serverEnv's ALERTS_ENCRYPTION_KEY and DATABASE_URL. Every updater-spawned installer and relaunched AppImage will inherit them. The relaunched app overrides both, so the behaviour is harmless, but the key travels into the installer's environment. The t-5/t-10 executor may want to note it. No draft owns it.
