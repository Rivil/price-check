# Plan Review — 06-remediate-security

Reviewed: 2026-11-20
Plan: 25 tasks across 7 waves

## BLOCKING
(none)

## FLAG
- [antipatterns / missing file] t-16 turns `e2e/desktop/background.e2e.ts` red and does not own it. `failureRows()` (background.e2e.ts:105-110) does a cookieless `rawRequest` to `/watches/<id>` and expects 200. Once t-16's gate is live, that request gets 403 and every background test that counts failure rows fails. The file is not in t-16's `files`, and the header's red window names only the packaged suite, so the plan does not account for a red desktop suite from t-16 onward. t-25 runs `pnpm test:e2e:desktop` and would hit it there.
  Suggestion: add background.e2e.ts to t-16's files (read the cookie via `session.cookies.get`, as the guard.e2e row already does, or go through the window), with a contract row saying it stays green.

- [antipatterns / missing file] t-10 turns `e2e/desktop/first-run.e2e.ts:61-62` red on macOS (mock keychain) and Windows (DPAPI). The test asserts that a freshly created alerts.key is raw base64 of 32 bytes, but t-10 writes new keys wrapped (`pcw1:`). t-10 does not own first-run.e2e.ts. t-17 (wave 3) does, but its description only adds the v0.1.5 migration case and never mentions inverting the existing fresh-key assertion. Between t-10 and t-17 the desktop suite is red on two OSes, and the plan does not acknowledge it.
  Suggestion: either move the fresh-key assertion change into t-10 (add the file), or state in t-17's description and contract that the existing 'key created in userData' assertion becomes backend-dependent, and record the t-10 to t-17 red window in the header the way the packaged one is.

- [test-contract / scope conflict] t-13's contract row 2 fails if `sign-mac.ts` "or anything it imports transitively (package-desktop.ts, …) has a runtime import other than node:*, relative files or `import type`". `scripts/package-desktop.ts:354` has `await import('electron-builder')`, a runtime bare-specifier import. The description also says "package-desktop.ts is not edited". If the check counts dynamic imports, the task cannot pass without editing a file it says it won't touch. If it counts only static imports, it misses the one import that would break in the install-free signing job if that path ever ran.
  Suggestion: state explicitly whether dynamic imports are in scope, and if so, whether t-13 may move or guard that import in package-desktop.ts (and add the file).

- [locked-decision] t-2's contract row "if a blank token on a new origin is refused when the saved token is null, ntfy.spec fails" adds an exception that locked `secret_on_destination_change` does not state. The decision text says a save that changes the ntfy origin with a blank secret field is refused. The carve-out fits the decision's rationale (there is no old secret to keep tied to the old destination), so this is not BLOCKING. Still, verify or review will read the literal text and may call it a violation.
  Suggestion: add a one-line clarification to the spec decision (or a plan header note) that the refusal applies only when a secret is saved. SMTP is unaffected, because smtp.ts requires a password.

## NOTE
- [coverage] Every criterion c-1 to c-27 appears in at least one task's `covers`. c-3, c-8, c-22, c-24 and c-25 are each covered in more than one layer (unit, desktop e2e, packaged e2e and CI), not by a single test.
- [wave-order] t-19 adds `verify-packaged.ts fuses` steps to release.yml for all three OSes in wave 3, but the fuses only flip in t-23 (wave 5). t-24 refuses to add the same step to ci.yml before t-23 for exactly this reason. release.yml runs only on a `v*` tag push, so branch CI stays green and nothing breaks unless a tag is cut from an intermediate commit. The two tasks still reason about the same step inconsistently.
- [granularity] t-22 carries the most risk in the plan: main-process control wiring, a CDP rewrite of the packaged harness, the update relaunch hand-over and five criteria in one commit. Before commit it is verified only by a local macOS run. Its Windows and Linux harness changes are first exercised by t-24's CI two waves later. The coupling (the harness cannot pass without the wiring) explains why it is one task, but a red t-24 on Windows or Linux will most likely trace back to t-22.
- [antipatterns] t-19's description says "a fail-closed allowlist for secret-bearing jobs", while its contract limits the rule to the five release secrets. repo-settings.yml (t-14) holds `REPO_SETTINGS_TOKEN`. If the executor follows the description's broader wording, t-14's workflow trips the rule. The 'shipped workflows clean' row would catch that, but the executor should follow the contract's scope.
- [files] t-5 hedges on where `kit.csp` goes ("lives in svelte config…"). The repo has no svelte.config.*. Kit's config is inline in `vite.config.ts` through `sveltekit({ adapter, compilerOptions })`, which is already in t-5's files, so the hedge can be dropped.
- [spec hygiene] spec.toml starts with a stray top-level `new = [".dross/security/x/report.md", "e2e-control.ts", …]` key above `[phase]`. It is not part of the plan, but it looks like tooling residue in a locked spec.
- [strength] File sequencing is careful. No two tasks in the same wave touch the same file, t-16 declares its t-9/t-10 dependency explicitly for file ordering, and the known packaged red window (t-16 to t-22) is written down, along with a ban on citing that suite as evidence while it is red. The two findings above are the gaps in that bookkeeping, not a missing practice.
- [strength] The contracts fail closed and can be falsified. They use secret sentinels to catch leaks, `?raw` source checks for imports and for `timingSafeEqual`, a 5-way concurrent `checkNow` on the real test DB rather than a mock, failure tables in the format the parsers read (every fuse wire, every repo-settings snapshot, every `pnpm audit` fixture), and observation-only rows that defer Windows and Linux green to CI rather than claiming it early.
- [strength] Cited references check out against the repo: `ntfy.spec.ts:324` 'write-only token', the harness.e2e 'launcher env' key assertion near line 111, the gitleaks-config.spec phase-allowlist test, and `missingSigningVariables` in package-desktop.ts. The header also requires the CI supply-chain checklist read before every workflow-editing task (t-14, t-19, t-21, t-24).

## Summary
The plan is sound and can proceed: coverage is complete and no locked decision is broken, but t-16 and t-10 each leave an existing desktop e2e file (background.e2e.ts, first-run.e2e.ts) red outside their scope, and t-13's import-isolation contract collides with package-desktop.ts's dynamic `electron-builder` import. Those should be fixed in the plan before execution.
