# 05-release — MVP lens draft

```
Phase 05-release — 8 tasks across 5 waves

Wave 1
  t-1  Add phase gitleaks entry and Linux README
       files:    .gitleaks.toml, README.md, scripts/readme.spec.ts
       covers:   c-1
       desc:     The only wave-1 task; every other task depends on it (vitest is red until the
                 entry lands). .gitleaks.toml tests.json allowlist gains
                 ^\.dross/phases/05-release/tests\.json$. README's Linux install line gains the
                 libfuse2 prerequisite (libfuse2t64 on Ubuntu 24.04+) and the Ubuntu 24.04+
                 AppArmor unprivileged-userns step (decision artefacts), never --no-sandbox.
       contract: if .gitleaks.toml lacks the exact anchored ^\.dross/phases/05-release/tests\.json$
                 path, gitleaks-config.spec 'every phase allowlisted' fails (red on this branch today)
                 if README's Linux install text lacks 'libfuse2', or lacks the AppArmor step
                 (apparmor_restrict_unprivileged_userns or an AppArmor profile instruction), readme.spec fails
                 if README anywhere tells a user to run with --no-sandbox, readme.spec fails (decision
                 artefacts keeps the Chromium sandbox)

Wave 2 (depends t-1)
  t-2  Add electron-builder packaging config and deps
       files:    package.json, pnpm-lock.yaml, pnpm-workspace.yaml, .gitignore,
                 scripts/package-desktop.ts, scripts/package-desktop.spec.ts
       covers:   c-1, c-2, c-3, c-4, c-5
       desc:     electron-builder (devDependency) and electron-updater (dependency), both exact
                 versions. pnpm-workspace.yaml gains supportedArchitectures (cpu x64 + arm64) so
                 both @libsql/darwin-* install. package-desktop.ts exports pure
                 desktopBuilderConfig({version?, feedUrl?, release}) and a CLI (dynamic-imports
                 electron-builder, --publish never) behind `pnpm package:desktop` (vite build +
                 build:desktop + package). Output to dist-packaged/ (gitignored).
       contract: if config.appId !== APP_ID imported from src/desktop/app-id.ts, package-desktop.spec fails (c-3)
                 if mac targets are not exactly dmg+zip with arch ['universal'], or mac.x64ArchFiles does
                 not match node_modules/@libsql/darwin-x64/index.node, package-desktop.spec fails (c-2)
                 if win target is not exactly nsis/x64, or nsis.oneClick !== true or nsis.perMachine !== false,
                 package-desktop.spec fails (c-3 per-user, no UAC)
                 if linux target is not exactly AppImage/x64, package-desktop.spec fails (milestone non-goal)
                 if asarUnpack does not cover node_modules/libsql/** and node_modules/@libsql/**, or
                 npmRebuild !== false, package-desktop.spec fails (c-1 libsql outside asar, never rebuilt)
                 if directories.buildResources is 'build' (electron-builder's default, which would drop
                 adapter-node's build/handler.js from the app) or files omit build/**, dist-desktop/** or
                 src/desktop/assets/**, or extraResources lacks drizzle -> drizzle, package-desktop.spec fails
                 if release:false yields mac.notarize true or a Developer ID identity, or release:true
                 yields notarize !== true or hardenedRuntime !== true, package-desktop.spec fails
                 if no feedUrl yields publish other than {provider:'github', owner:'Rivil', repo:'price-check'},
                 or feedUrl 'http://127.0.0.1:45123/' yields other than a generic provider with that url,
                 package-desktop.spec fails (decision update_flow: feed fixed at package time)
                 if version '0.1.5-rc.1' is not stamped as extraMetadata.version, or no version leaves one set,
                 package-desktop.spec fails (c-4 stamping)
                 if pnpm-workspace.yaml supportedArchitectures.cpu lacks x64 or arm64, or package.json pins
                 electron-builder/electron-updater with a range, or electron-updater is not under
                 dependencies, package-desktop.spec fails

  t-3  Add release tag gate and write allowlist
       files:    scripts/release-tag.ts, scripts/release-tag.spec.ts,
                 scripts/workflow-policy.ts, scripts/workflow-policy.spec.ts
       covers:   c-4
       desc:     release-tag.ts (no deps, node type stripping) exports checkReleaseTag({tag,
                 packageVersion, onMain}) -> {ok:true, version, prerelease} | {ok:false, reason};
                 CLI resolves onMain via `git merge-base --is-ancestor <sha> origin/main` and
                 writes version/prerelease to GITHUB_OUTPUT. WRITE_SCOPE_ALLOWLIST becomes
                 exactly { 'release.yml': ['contents'] }.
       contract: if v0.1.4 with package 0.1.4 on main is not {ok, version '0.1.4', prerelease false}, or
                 v0.1.4-rc.2 is not {ok, version '0.1.4-rc.2', prerelease true}, release-tag.spec fails
                 if v0.1.5 against package 0.1.4, or onMain false for a matching tag, returns ok,
                 release-tag.spec fails (c-4: off main / mismatch publishes nothing)
                 if any of '', 'v', '0.1.4', 'v0.1.4-rc', 'v0.1.4-beta.1', 'v0.1.4-rc.1+meta', 'v0.1.4.1'
                 returns ok, release-tag.spec's table fails (edge: empty)
                 if the CLI exits 0 or writes GITHUB_OUTPUT when the injected ancestor check exits non-zero,
                 release-tag.spec fails
                 if WRITE_SCOPE_ALLOWLIST is not deep-equal { 'release.yml': ['contents'] }, workflow-policy.spec fails
                 if checkWorkflow('release.yml', …) passes a job-level packages: write or a workflow-level
                 contents: write, or checkWorkflow('ci.yml', …) passes a job-level contents: write,
                 workflow-policy.spec fails

Wave 3
  t-4  Add updater and tray Restart item   (depends t-2)
       files:    src/desktop/updater.ts, src/desktop/updater.spec.ts,
                 src/desktop/tray.ts, src/desktop/tray.spec.ts
       covers:   c-5
       desc:     updater.ts (electron types via import type only; autoUpdater injected as a factory)
                 startUpdater({isPackaged, getAutoUpdater, version, notify, onReady, timers}):
                 unpackaged -> inert handle; packaged -> autoDownload on, autoInstallOnAppQuit off,
                 allowPrerelease = version has a -rc.N suffix, check at start and every 6 h; on
                 update-downloaded -> notify once per version, onReady(). Handle {state(), restart(),
                 applyOnExit()} also published on globalThis[Symbol.for('price-check.updater')].
                 Tray template gains 'Restart to update' (above Quit) only while the update is ready.
       contract: if an unpackaged start calls getAutoUpdater or schedules any timer, updater.spec fails
                 if a packaged start does not call checkForUpdates once immediately and again at exactly
                 6*60*60*1000 ms and 12 h (fake timers), updater.spec fails
                 if two update-downloaded events for 0.1.5 notify twice, or 0.1.5 then 0.1.6 notify other
                 than twice, updater.spec fails (one notification per version)
                 if a rejecting checkForUpdates or an 'error' event throws or stops the 6 h schedule,
                 updater.spec fails
                 if applyOnExit() with nothing downloaded calls quitAndInstall, or after a download calls it
                 other than (true, false) after a plain quit / (true, true) after restart(), updater.spec fails
                 (Quit installs; Restart relaunches; never a forced restart)
                 if electron-updater's GitHubProvider, fed a recorded releases.atom (inline string, no
                 network) listing v0.1.5 and v0.1.5-rc.1, resolves anything but 0.1.5 for an updater
                 configured by startUpdater at version 0.1.5-rc.1, or resolves any update for 0.1.4 given
                 only v0.1.5-rc.1, updater.spec fails (c-5 rc takes final; final never takes rc)
                 if trayMenuTemplate shows 'Restart to update' while the update is not ready, or omits it
                 (or puts it below Quit) once ready, or its click does not call restart() once, tray.spec fails

  t-5  Add packaged smoke harness, packaged cwd   (depends t-2)
       files:    e2e/packaged/packaged.ts, e2e/packaged/smoke.packaged.ts,
                 playwright.packaged.config.ts, src/desktop/main.ts
       covers:   c-1, c-2, c-3
       desc:     main.ts: the server cwd is process.resourcesPath when packaged (chdir into app.asar
                 fails; drizzle ships there via t-2 extraResources), else APP_ROOT. packaged.ts
                 locates/installs the artefact in PACKAGED_DIR (default dist-packaged): macOS .app,
                 Windows silent NSIS /S, Linux AppImage; launches via _electron executablePath;
                 resolves the OS default userData. *.packaged.ts suffix keeps both existing
                 Playwright configs from collecting these specs. Executor observes macOS green locally.
       contract: if the packaged userData dir exists without the harness's own marker file,
                 packaged.ts throws before launching or deleting anything (never touches a real user's data)
                 if launch 1 on an empty userData does not show the empty watchlist, smoke.packaged fails (c-1)
                 if a watch seeded through seed-child, retargeted through the app's watch-page form, is not
                 listed with the new target after quit + relaunch, smoke.packaged fails (c-1 persists)
                 if process.report.getReport().sharedObjects in main has no libsql .node path under
                 app.asar.unpacked, smoke.packaged fails (c-1 libsql outside asar)
                 if main.ts chdirs into app.asar (no resourcesPath branch), the packaged server never
                 starts and smoke.packaged's first launch fails
                 macOS: if `lipo -archs` on the app executable is not {arm64, x86_64}, or either
                 @libsql/darwin-arm64 or @libsql/darwin-x64's .node is missing under app.asar.unpacked,
                 smoke.packaged fails (c-2)
                 Windows: if after the silent install the uninstall key is under HKLM or absent from HKCU,
                 the exe is not under %LOCALAPPDATA%\Programs, or the Start Menu .lnk's
                 System.AppUserModel.ID !== APP_ID, smoke.packaged fails (c-3)

Wave 4
  t-6  Add release workflow and release environment   (depends t-2, t-3, t-5)
       files:    .github/workflows/release.yml, scripts/release-workflow.spec.ts,
                 .github/environments/release.json
       covers:   c-1, c-2, c-4
       desc:     release.yml on push tags v*: gate job (fetch-depth 0, release-tag.ts) -> three
                 build jobs (macos-15 / windows-2025 / ubuntu-24.04, contents: read, frozen
                 lockfile, no caches, package --publish never with the gate's version, packaged
                 smoke, upload-artifact) -> publish job (needs all, only contents: write, only
                 download-artifact + gh). macOS job alone takes environment 'release' and the five
                 secrets, fails if any is empty, writes AuthKey.p8 to RUNNER_TEMP, then lipo,
                 codesign/spctl/stapler before upload. release.json pins the env (v* tag policy);
                 executor applies it with gh api like phase 01's rulesets.
       contract: if release.yml triggers on anything but push of tags 'v*', release-workflow.spec fails
                 if checkWorkflow(release.yml) (ci:policy) reports any violation, release-workflow.spec fails
                 if any job but publish grants a write scope, or publish lacks needs on gate and all three
                 builds, release-workflow.spec fails (c-4 any failed build publishes nothing)
                 if publish has a checkout, setup-node, pnpm/npm/node step, or any run line not starting
                 with gh/test/ls/a shell builtin, release-workflow.spec fails (writer runs no repo code)
                 if publish does not `gh release view` the tag and exit non-zero when it exists before its
                 single `gh release create`, or create omits any of *.dmg, *.zip, *.exe, *.AppImage,
                 latest*.yml, or --prerelease is not driven by the gate's prerelease output,
                 release-workflow.spec fails (c-4 idempotency, rc pre-release)
                 if any of the five secret names appears outside the macOS job's signing/packaging step, a
                 job other than macOS sets environment: release, or the macOS job has no step failing on
                 an empty credential before packaging, release-workflow.spec fails (c-4, release_secrets)
                 if the macOS job lacks codesign --verify --deep --strict, spctl --assess, xcrun stapler
                 validate and lipo after packaging and before upload, release-workflow.spec fails (c-2)
                 if any build job uploads before running playwright.packaged.config.ts, release-workflow.spec
                 fails (c-1 smoke on release artefacts)
                 if release.yml contains actions/cache, a setup-node cache:, a pnpm install without
                 --frozen-lockfile, a checkout without persist-credentials: false, or --feed /
                 PRICE_CHECK_UPDATE_FEED, release-workflow.spec fails (release_pipeline, update_flow)
                 if release.json's deployment policy is not custom with exactly one tag pattern 'v*',
                 release-workflow.spec fails

  t-7  Wire updater; install after shutdown   (depends t-4, t-5)
       files:    src/desktop/lifecycle.ts, src/desktop/lifecycle.spec.ts, src/desktop/main.ts
       covers:   c-5, c-6
       desc:     LifecycleDeps gains beforeExit(): called once after the shutdown (or its deadline)
                 and before app.exit(0). main.ts starts the updater (getAutoUpdater = () =>
                 electron-updater's autoUpdater, notify via notifications.notifier with clickPath
                 '/'), passes updater.applyOnExit as beforeExit and the ready/restart pair to the
                 tray, rebuilding the tray menu on ready. Executor also runs pnpm check.
       contract: if lifecycle.spec's call-order log is not [..., 'db-closed', 'beforeExit', 'exit(0)'],
                 lifecycle.spec fails (c-6: installer spawned only after the DB is closed)
                 if a shutdown that passes SHUTDOWN_DEADLINE_MS exits without calling beforeExit, or a
                 throwing beforeExit stops exit(0), lifecycle.spec fails
                 if two before-quit events call beforeExit twice, lifecycle.spec fails
                 if the real main.ts entry (now importing electron-updater) fails to bundle, the existing
                 build-desktop.spec 'real entry' fails; if updater.ts/tray.ts/lifecycle.ts value-import
                 electron, the existing boundary.spec fails
                 if an unpackaged launch touches autoUpdater, the existing desktop e2e (quit-relaunch,
                 first-run) fails on its update error / quit path (not vitest-gated; executor observes
                 pnpm test:e2e:desktop green before committing)

Wave 5 (depends t-5, t-7)
  t-8  Prove updates; run packaged suites in PR CI
       files:    e2e/packaged/update.packaged.ts, e2e/packaged/packaged.ts,
                 .github/workflows/ci.yml, scripts/ci-desktop.spec.ts
       covers:   c-1, c-2, c-3, c-5, c-6
       desc:     update.packaged.ts (skips darwin): old build = the job's package with a fixed
                 127.0.0.1 feed; packages a patch-bumped build into a second dir and serves it
                 from that feed. ci.yml's existing test matrix gains, after desktop e2e:
                 package:desktop --feed <fixed>, CSC_IDENTITY_AUTO_DISCOVERY=false, Linux
                 libfuse2t64 + xvfb, then the packaged config. No new job, so required check
                 names and rulesets stay as they are; timeout raised.
       contract: Windows/Linux: if, with a seeded watch, the old install does not reach updater
                 state 'downloaded' for the new version at launch, update.packaged fails (c-5)
                 if after restart() through the updater handle no process from the installed path
                 appears, or its start time precedes the old process's exit, update.packaged fails (c-6)
                 if relaunching that install under Playwright gives app.getVersion() !== new version, the
                 seeded watch is missing, or the log shows 'database is locked', update.packaged fails (c-5, c-6)
                 if app.quit() (Quit path) on a freshly installed old build does not leave the new version
                 installed on the next launch with the watch intact, update.packaged fails (c-5 Quit installs)
                 if ci.yml's test matrix does not run package:desktop then
                 `playwright test --config playwright.packaged.config.ts` on linux, macos and windows after the
                 desktop e2e step, ci-desktop.spec fails (c-1 every PR, all three OSes)
                 if the Linux packaged step lacks libfuse2t64, the AppArmor sysctl or xvfb-run, or any step
                 passes --no-sandbox, ci-desktop.spec fails
                 if ci.yml references CSC_LINK, CSC_KEY_PASSWORD or any APPLE_* secret, or packaging lacks
                 CSC_IDENTITY_AUTO_DISCOVERY: 'false', ci-desktop.spec fails (PR never signs)
                 if ci.yml's check names change (a new job), the existing rulesets.spec fails
                 (executor observes the PR's three test jobs green; the packaged suites first run there)
```

## Coverage

| Criterion | Tasks |
|---|---|
| c-1 packaged opens empty, persists, libsql outside asar; PR + release smoke | t-1 (README Linux prerequisites), t-2 (asarUnpack, files, drizzle), t-5 (smoke + packaged cwd), t-6 (release smoke before upload), t-8 (PR CI on 3 OSes) |
| c-2 universal mac, both libsql, codesign/spctl/stapler | t-2 (universal, x64ArchFiles, supportedArchitectures, notarize), t-5 (lipo + both binaries), t-6 (codesign/spctl/stapler + lipo in release job), t-8 (PR run on macos-15) |
| c-3 per-user NSIS, shortcut AUMID = APP_ID, CI-checked after silent install | t-2 (appId from APP_ID, oneClick, perMachine false), t-5 (HKCU + .lnk AUMID checks), t-8 (runs them on windows-2025 every PR) |
| c-4 tag gate, one release, rc pre-release, refusals | t-2 (version stamping), t-3 (gate + write allowlist), t-6 (release.yml + env) |
| c-5 launch + 6 h checks, background download, one notice, tray item, Restart/Quit install, rc rules, CI on Win+Linux | t-2 (feed at package time), t-4 (updater + tray), t-7 (wiring), t-8 (Win/Linux e2e) |
| c-6 Windows relaunch only after old process exits, DB intact | t-7 (beforeExit after DB close), t-8 (process start-time vs old exit, data intact on windows-2025) |

## Judgment calls

- Gitleaks entry shares wave 1 with the README Linux prerequisites, not the packaging config. The alternative would make the packaging task 7 files. Both are two-file hygiene edits that need nothing else.
- Packaging config is a pure `desktopBuilderConfig()` in scripts/package-desktop.ts (like build-desktop.ts), not an electron-builder.yml/.ts file. That makes the APP_ID import, the version stamp, the feed URL and the release flag unit-testable, and avoids relying on electron-builder's TS-config loader.
- Packaged specs use the `*.packaged.ts` suffix plus their own Playwright config. The alternative was editing playwright.config.ts / playwright.desktop.config.ts testIgnore. Neither existing config collects the suffix, so no other files are touched.
- No new CI job: packaging and the packaged suites go into the existing `test` matrix. A new job would change required check names, which means editing the rulesets, rulesets.spec and a gh api re-apply. It would also re-install deps on 3 OSes, where the matrix job reuses its vite/esbuild output.
- "Saves a watch" is proven by a watch seeded with seed-child and then retargeted through the app's own form. Adding a watch through the UI always fetches the shop (addWatch → deps.check), which r-01 forbids. The retarget still proves the packaged libsql writes, and that the write survives a relaunch.
- The packaged server cwd becomes process.resourcesPath with drizzle as an extraResource. The alternative was asarUnpacking drizzle and using app.asar.unpacked. Today main.ts chdirs into APP_ROOT, which is app.asar once packaged, and Electron can't chdir into an archive. resourcesPath is a real directory on every OS.
- The update is applied by our lifecycle's beforeExit after the DB is closed, with autoInstallOnAppQuit off. The alternative was electron-updater's quit hook. lifecycle quits through app.exit(0), which skips the will-quit/before-quit path that the auto-install relies on. Ordering it explicitly is also what c-6 asks for.
- The updater handle is published on a global Symbol so the e2e can call restart(). The alternative was an unpackaged-only seam, but the packaged build ignores e2e seams, and tray menus can't be clicked from Playwright. The handle only exposes state/restart/applyOnExit, not a feed or URL override.
- rc-vs-final is proven by a vitest that drives electron-updater's GitHubProvider over an inline releases.atom. The alternative was a third packaged rc build in the e2e. The CI e2e uses a generic feed, so it can't catch GitHub-provider channel selection, and that selection is the c-5 rule most likely to fail at device UAT.
- The e2e drives the Quit path with app.quit() and the Restart path through the handle. Both run on the same two builds, so proving both halves of "Restart or Quit installs" costs no extra packaging.
- The packaged harness refuses to run over an existing userData dir that has no harness marker. Packaged builds ignore PRICE_CHECK_USER_DATA, so a local macOS run would otherwise delete a real user's data.
- There is no separate "smoke in CI" task. The CI wiring waits for the update e2e (t-8), so ci.yml and ci-desktop.spec are edited once rather than twice.
