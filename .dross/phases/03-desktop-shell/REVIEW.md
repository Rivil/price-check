# Plan Review — 03-desktop-shell

Reviewed: 2026-11-14
Plan: 14 tasks across 5 waves

## BLOCKING
(none)

## FLAG
- [antipatterns] macOS login launch: the task contracts don't fit together. t-13 'login is tray-only' launches with `--login-launch` and asserts no BrowserWindow, and t-14 runs that suite on macos-15. t-6 requires argv detection only "(win32/linux)" and says darwin detects via `wasOpenedAtLogin`. If the executor implements t-6 as written, with argv ignored on darwin, the macOS desktop e2e opens a window and fails. Separately, t-6 asks the executor to "confirm `wasOpenedAtLogin` still reports on macOS 13+ ... and record the finding", but it has no fallback if the answer is no. In that case c-6's "a login launch shows only the tray" is broken on macOS, and nothing in the plan catches it, because e2e uses argv.
  Suggestion: In t-6's isLoginLaunch contract, state whether darwin also honours `--login-launch` (so e2e can drive it) and what darwin does if `wasOpenedAtLogin` turns out to be unreliable under SMAppService.

- [locked-decision gap] login_start (locked) says "Unpackaged dev and test runs never register." t-6 contract 3 ("an unpackaged run ... registers anything") reads as a launch-time `ensureRegisteredOnce` check. Nothing pins what `setEnabled(true)` does when it is called from the t-7 tray toggle in an unpackaged run. Implemented naively, ticking "Start at login" during `pnpm dev:desktop` registers the bare electron binary, which is exactly what the decision forbids.
  Suggestion: Extend t-6's unpackaged contract to name `setEnabled(true)` explicitly (no-op or disabled when unpackaged).

- [test-contract] c-9 says "Quit (tray or app menu)", but neither real entry point is tested end to end. t-11 quits via `app.quit()` from evaluate. t-7 only proves that the tray's Quit calls an injected `quitApp`. t-9 adds the macOS app menu with role 'quit' and wires `quitApp` in main.ts, but t-9's three contracts cover only the import boundary and the bundle, not that `quitApp` reaches the before-quit shutdown path or that the menu exists.
  Suggestion: Give t-9 a contract on the main.ts wiring (quitApp → app.quit, menu has role 'quit' on darwin), or have t-11 quit through the tray or menu item.

- [test-contract] t-14's Electron binary cache is under-specified, and no ci-desktop.spec contract checks it. The electron postinstall downloads during `pnpm install --frozen-lockfile`, so the cache step has to restore *before* the install step. It also has to point `electron_config_cache` at a path inside the workspace: Electron's default cache is in the home dir, and this repo already notes that CI cache paths must sit inside the project dir (the same pattern as PLAYWRIGHT_BROWSERS_PATH). A cache step added after install, or on the default path, passes every listed contract and saves nothing.
  Suggestion: Add a ci-desktop.spec contract that pins the cache step before `pnpm install` and checks the `electron_config_cache` path. The in-workspace cache dir also needs ignoring.

- [antipatterns] CI cost: t-10 defines `test:e2e:desktop` as "builds web + desktop". t-14 runs it right after `pnpm test:e2e`, whose webServer has already run `pnpm build` in the same job. That is a second `vite build` per OS (×3), against the build-once rule in reference_ci_pipeline_optimisation.md. t-14's executor note says to read that reference, but t-10 pins the double build first.
  Suggestion: Let CI reuse the existing `build/` (for example a script variant or flag that skips the web build when it is current), and keep the full build for local runs.

- [granularity] t-10 touches 7 files across separate concerns: the Electron launcher and harness (launch.ts, harness.e2e.ts), the Playwright config split (both configs), tsconfig, package.json scripts, and a vitest check placed in build-desktop.spec. t-2 (6 files) mixes a scheduler semantics change (requestPass/stop) with a new cross-bundle bridge and the hooks wiring. t-3 (6 files) bundles three independent modules (app-paths, alerts-key, server-env). t-1's 6 files are cohesive (lockfile and workspace are mechanical), so no split is needed there.
  Suggestion: Consider splitting t-10 into config split and launcher/harness, and t-2 into scheduler and bridge/hooks. t-3 is acceptable as is if the author prefers.

- [antipatterns] t-7 lists two binary files (`src/desktop/assets/tray-icon.png`, `tray-iconTemplate.png`) but doesn't say where they come from. A writer agent cannot author a PNG with Write, the repo is public (AGPL, so the asset's source and licence matter), and a macOS Template image must be black with alpha (normally with a @2x variant) to render correctly in a dark or light menu bar. The contract only checks that the files exist and that darwin uses the Template one.
  Suggestion: Name the source or generation method (for example a small script that emits the PNGs, or a licensed asset) and the required sizes in t-7's description.

## NOTE
- [coverage] All of c-1..c-9 appear in at least one task's `covers`. There are no locked-decision conflicts: port 0 on 127.0.0.1, the node:http wrapper doing the Host check before sirv, ORIGIN/HOST_HEADER stripped, the userData key file at 0600 with no safeStorage, the marker-based once-only login registration, close never quitting, and deny-all window.open plus openExternal all match the spec.
- [rules] r-01 and r-03 are respected. Scheduler-enabled e2e runs are restricted to unsupported `.invalid` URLs, and t-10 adds a launcher guard that throws before launch otherwise. The ntfy channels use `.invalid` hosts (ntfy.ts accepts self-hosted servers, so this is achievable). runtime.mode is native, so running pnpm directly is fine.
- [strengths] The adapter-node integration is grounded in the real source. adapter-node 6's handler.js awaits `server.init` at module top level, so hooks init has run and published the runtime once the dynamic import resolves; t-8 reading the runtime after startServer is sound. `normalise_header` throws on a multi-valued protocol header and defaults to 'https', which is exactly what t-4's "exactly one 'http' value" contract guards. `migrate.ts` resolves drizzle/ from cwd, which t-4's chdir-before-import contract handles.
- [strengths] Cross-bundle state goes through `globalThis[Symbol.for(...)]`, with a contract that two module instances (vi.resetModules) see the same runtime. That is the correct fix for the Vite server bundle and the esbuild main bundle each holding their own copy of the bridge module.
- [strengths] The lifecycle contracts target real Electron failure modes: `setPath('userData')` before `requestSingleInstanceLock` (the lock is keyed by userData), the zombie-instance case on a bad key file (showErrorBox then exit(1) with no tray), a re-entrant before-quit, and a shutdown deadline that guarantees `app.exit`.
- [wave-order] t-8 `depends_on` t-1 although its description limits its types to runtime-bridge (t-2). This has no effect, since t-2 already puts t-8 in wave 2.
- [coverage] t-14 claims all nine criteria but proves none of them itself. Its contracts are about CI shape. Only c-9's "Windows included" and the three-OS claims depend on it. This inflates the traceability map; consider whether verify should credit it.
- [coverage] c-6 registration and the tray toggle can only be proven at unit level in this phase, because the locked decision bars unpackaged registration and 03 runs unpackaged. A packaged smoke check in 05 is the first real end-to-end proof.
- [coverage] t-13's "checks keep running" with the window closed is driven by a synthetic powerMonitor 'resume' (requestPass), not by the 5-minute interval. That the interval survives window close rests on t-8's window-all-closed contract (no `runtime.stop`). This is reasonable given TICK_MS, but worth knowing at verify time.
- [antipatterns] t-10 puts its 'playwright config split' assertion in `scripts/build-desktop.spec.ts`, which has nothing to do with the desktop build. It works (vitest-gated), but it makes that spec a grab-bag edited by three tasks (t-1, t-9, t-10).

## Summary
The plan is strong and execution-ready, with complete coverage, no locked-decision conflicts and contracts that are unusually concrete and source-accurate. The macOS login-launch contract gap and the untested real quit paths should be tightened before execution.
