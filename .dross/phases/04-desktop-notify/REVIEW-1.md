# Plan Review — 04-desktop-notify

Reviewed: 2026-11-14
Plan: 11 tasks across 6 waves

## BLOCKING
- [antipatterns: unowned regression] `e2e/desktop/guard.e2e.ts:135` launches real Electron, saves ntfy, then asserts `expect(stored.channels.map(({ kind }) => kind)).toEqual(['ntfy'])`. Once t-8 seeds the desktop row at server init, that snapshot (seed-child orders channels by kind asc) becomes `['desktop', 'ntfy']` and the test fails on all three CI OSes. No task lists `e2e/desktop/guard.e2e.ts` in `files`. t-10 and t-11 both gate on "executor observes `pnpm test:e2e:desktop` green locally", and that cannot happen unless a writer edits a file outside its task scope.
  Suggestion: add `e2e/desktop/guard.e2e.ts` to t-8 or t-10 with a contract stating the expected post-seed channel list, so the change is owned and reviewed. While there, check `quit-relaunch.e2e.ts` and `background.e2e.ts` for other channel-count assumptions. I found none, but they are the other real-Electron specs that open the alerts page or run checks.

## FLAG
- [granularity] t-7 touches 6 files and combines four separate concerns:
  1. Publishing the notifier before the handler import (`server.ts`, `server.spec.ts`, `testing/fake-handler.ts`).
  2. AUMID ordering in `lifecycle.ts`.
  3. Click routing in `lifecycle.ts` (held until ready, latest wins, dropped while quitting).
  4. `main.ts` wiring.

  The `server.ts` part needs only t-1, yet it waits for t-3/t-4/t-5.
  Suggestion: split the notifier-before-import piece (server.ts + server.spec + fake-handler) into its own wave-2 task. That leaves t-7 as lifecycle + main.
- [granularity] t-2 touches 6 files and combines three changes that don't depend on each other:
  - the ChannelKind/FailureReason widening, plus the forced `ntfy.spec.ts` labels-table edit
  - `Alert.watchId` (`alerts.ts`/`alerts.spec.ts`)
  - `ensureChannel` (`channels.ts`/`channels.spec.ts`), which has four contracts of its own, including the concurrency and re-seal cases

  Suggestion: split `ensureChannel` into its own wave-2 task. t-6 would then depend on both halves.
- [granularity] t-9 has 5 files across three layers: form actions (`+page.server.ts`), the Svelte card, and a web Playwright spec (`alerts.e2e.ts`). The work is one cohesive card, so keeping it together is defensible. Its gate is split, though: the last contract is explicitly "not vitest-gated", so the task is green only after two separate runners pass.
  Suggestion: keep as is, but make sure the executor knows the commit waits for `pnpm test:e2e` as well as vitest. Alternatively, move the "no Desktop card under the node server" assertion into t-10/t-11's e2e scope.
- [locked-decision drift, not a conflict] `default_on_seed` (locked) says the row "is created at startup only when no desktop row exists". t-2's `ensureChannel` also re-seals an *existing* desktop row whose config cannot be opened. That writes `config_enc`, and probably `updated_at`, at startup. Flags are kept, so the decision's rationale ("never re-enables a user's off") still holds. Still, this is startup behaviour on an existing row that the locked text does not name.
  Suggestion: either record the re-seal as an amendment note on `default_on_seed`, or confirm it with the user before execution, so a later spec-fidelity review doesn't read it as a violation.
- [test contract] t-8 contract 4 ("the registration made in one hooks.server.spec test is still in channelKinds() in the next") checks spec hygiene, not a production behaviour. The description also never says how the spec reaches the unregister: `init` is a `ServerInit` returning `Promise<void>`, and nothing in the plan exports or stores the function `installDesktop` returns. The writer will have to invent a mechanism, such as mocking `installDesktop` or adding an extra export on `hooks.server.ts`.
  Suggestion: state the mechanism (e.g. "the spec wraps installDesktop via vi.mock importOriginal and calls the captured unregister in afterEach"), or drop the contract as test plumbing.

## NOTE
- [coverage] All six criteria are covered:

  | Criterion | Tasks |
  |---|---|
  | c-1 | t-1, t-2, t-4, t-5, t-6, t-7, t-8, t-10 |
  | c-2 | t-2, t-3, t-4, t-5, t-6, t-7, t-10 |
  | c-3 | t-2, t-6 |
  | c-4 | t-2, t-6, t-8, t-9, t-10, t-11 |
  | c-5 | t-2, t-4, t-5, t-6, t-9, t-10, t-11 |
  | c-6 | t-5, t-7 |

  c-6's packaged half is deferred to 05, per the spec.
- [locked decisions] No conflicts found:
  - `notify_bridge`: t-1/t-7. The bridge has no imports, and the notifier is published before the import, which the `fake-handler` contract pins.
  - `desktop_only_driver`: t-8, plus the t-9 node-server e2e.
  - `click_target`: t-6 clickPath; ntfy/Resend/SMTP keep `canonicalUrl` per the t-2 contract.
  - `delivery_result`: t-5 settle-as-delivered, t-6 failure means no delivery row.
  - `app_user_model_id`: t-5 `app-id.ts` with no imports, so 05 can read it.
  - `macos_permission`: nothing in the plan adds a welcome notification.
- [rules] r-01 is honoured. Desktop e2e alerts come from `https://shop.e2e.invalid/` URLs (unsupported, no fetch), and t-6 uses a fake fetch. No workflow file is edited, so the CI-hygiene audit is not triggered. r-04 (soft): t-2 and t-7 name `pnpm check` but no task names `pnpm lint`, so the executor's commit flow needs to cover it.
- [risk, unverified] t-5 releases a notification on `'close'`. On Windows, Electron may emit `close`/dismissed when a toast times out into Action Center and then destroy the native toast. If so, clicking it there while the app is still running does nothing. The spec's deferred item only covers clicks after quit or relaunch. This can't be settled without a packaged Windows run, so add it to 05's per-OS smoke test rather than this plan.
- [scope] The price-drop path is never run in real Electron: the e2e alerts are all failed checks, because r-01 rules out a successful check. c-1's "item, new price, target" body and c-3's once-per-target behaviour rest on t-6's unit tests over `createTestDb()`. That is the right trade-off, but it is the reason c-3 has no e2e. Also, c-1's "Resend and SMTP still get the alert" is tested only through ntfy. Routing is generic over `channelsFor`, so that is acceptable.
- [strength] Every test contract names the spec, the input and the exact observable result: `'/watches/a%2Fb%3Fc'`, `vi.getTimerCount() === 0` after settle, the call-order log `['key','migrated','desktop','scheduler','published']`, and "first and only loadURL". None of them says "tests pass".
- [strength] The plan caught a precondition that is red on this branch today. `scripts/gitleaks-config.spec.ts:57` requires a tests.json entry for every phase that has a `spec.toml`, and `.gitleaks.toml` stops at 03. The plan makes this wave 1, so no later task's vitest gate is red for an unrelated reason. That is also why t-3 and t-4 sit behind t-1 although they use nothing from it.
- [strength] The e2e seam is shaped well. It is unpackaged-only (a contract proves packaged runs ignore `PRICE_CHECK_E2E_NOTIFY`), the same recorder path runs on all three OSes without a notification daemon, and t-11 adds one test against the real `Notification` class that accepts either `isSupported()` result. "Without a path, a live window is not reloaded" in t-3 also stops a tray Open or a second instance from overwriting a notification-driven navigation.

## Summary
The plan is well specified and true to the locked decisions, but it misses that the desktop seed breaks `e2e/desktop/guard.e2e.ts:135`, which no task owns. Fix that before executing. The split candidates in t-2 and t-7 are worth considering but don't block.
