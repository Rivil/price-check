# Plan Review — 04-desktop-notify

Reviewed: 2026-11-14
Plan: 11 tasks across 6 waves

## BLOCKING
(none)

Coverage is complete. Every criterion c-1 to c-6 appears in at least one task's `covers`: c-3 via t-2/t-6, c-6 via t-5/t-7, the rest several times. No task contradicts a locked decision (notify_bridge, desktop_only_driver, default_on_seed, click_target, delivery_result, app_user_model_id, macos_permission). No rule is broken: runtime is native pnpm, r-01 is honoured with fake fetch and `shop.e2e.invalid` URLs, no fixtures (r-02), no infra details (r-03), and no CI workflow edit.

## FLAG
- [wave-order] t-8 seeds the desktop row at every Electron startup, which turns `e2e/desktop/guard.e2e.ts` red on all three OSes (`toEqual(['ntfy'])` at ~line 135). The fix is held back to t-10 (wave 5), so the t-8 and t-9 commits land with a known-red desktop e2e suite. The plan says so, which is good, but the branch history is not bisectable on desktop e2e across waves 4 and 5. The fix is one assertion line, and t-7 (wave 3, which publishes the notifier) is already in place when t-8 runs.
  Suggestion: move the guard.e2e assertion change into t-8's `files`, and have t-8's executor run `pnpm test:e2e:desktop` (only guard.e2e is affected) before committing. Then no commit is knowingly red.

- [test-contract] t-8 does not say what happens when `installDesktop`/`ensureChannel` rejects inside `init`. As written, the rejection propagates out of `init`, so the handler import fails, `startServer` throws, and lifecycle shows the startup error box and exits 1. A failed seed of an optional channel would then take down the whole app. t-7 explicitly makes a throwing `setAppUserModelId` "logged and skipped", so leaving the seed's failure path unspecified looks like an oversight, not a choice.
  Suggestion: add a t-8 contract that pins the intended behaviour either way: startup fails loudly, or the error is logged and `init` continues to the scheduler without desktop.

- [granularity] t-7 touches 6 files and bundles three separable concerns. (a) `server.ts`/`server.spec.ts`/`fake-handler.ts`: publish the notifier before the dynamic import. This needs only t-1. (b) `lifecycle.ts`/`lifecycle.spec.ts`: AUMID ordering plus click hold/route/drop. (c) `main.ts` wiring, which needs t-3/t-4/t-5. Part (a) could run in wave 2 alongside t-3..t-5. Bundling it into a wave-3 task with eight contracts makes t-7 the largest single review unit in the plan.
  Suggestion: consider splitting (a) out as its own wave-2 task, leaving lifecycle and main wiring in t-7.

- [granularity] t-2 touches 6 files. It combines two changes that share no code. One is type additions plus `Alert.watchId`: `channel.ts`, `alerts.ts`, `alerts.spec.ts`, `ntfy.spec.ts`. The other is the new `ensureChannel` upsert: `channels.ts`, `channels.spec.ts`, plus a concurrency contract. The split would not change wave order (t-6 needs both), so the gain is review size only.
  Suggestion: optional. Split `ensureChannel` into its own wave-2 task if you want smaller diffs; otherwise keep it.

- [granularity] t-9 touches 5 files across three layers: the form-action server (`+page.server.ts`), the Svelte UI (`+page.svelte`) and the node-server Playwright e2e (`alerts.e2e.ts`), with 12 contracts. That is the split threshold. The server action change (remove refusal) is independent of the card markup.
  Suggestion: consider splitting the server action and the Svelte card into two wave-4 tasks. They do not depend on each other at commit time, since page.svelte.spec feeds `data` directly.

## NOTE
- [wave-order] t-2, t-3 and t-4 depend on t-1 only through the test gate, not through code. window.ts and notify-seam.ts never touch notify-bridge, and t-2 does not either. The dependency is real, though: verified that `.gitleaks.toml` has entries for 01–03 only, and `scripts/gitleaks-config.spec.ts` 'every phase allowlisted' scans every phase dir with a spec.toml, so vitest is red on this branch today. Putting the gitleaks fix in the sole wave-1 task is the right call.
- [locked-decision] t-2's `ensureChannel` also re-seals an existing row whose config cannot be opened. Decision default_on_seed says the row "is created at startup only when no desktop row exists". Re-sealing goes beyond that text but keeps its intent: flags are untouched, and the config is `{}` with no secret. Without it, `channelsFor` would skip an undecryptable desktop row forever. No conflict; recorded so the verifier does not read it as one.
- [coverage] In real Electron (t-10/t-11), every alert comes from a failed check, because a price-drop check needs a successful live fetch, which r-01 forbids. c-1's "naming the item, its new price and the target" is therefore proved only in vitest (t-6: title contains the watch title, body contains '£9.00' and '£10.00'). The bridge → main path is the same for both alert kinds, so this is a sound trade-off, not a gap.
- [test-contract] t-10 and t-11 gate commits on `pnpm test:e2e:desktop` "green locally", which runs on one OS. The Windows-only branches (minimise/restore, unpackaged AUMID = execPath) and the Linux xvfb branches (minimise skipped, real-class `isSupported()` tolerance) are first exercised in CI after push. Verify should read the CI matrix result, not the local run, for those claims.
- [test-contract] The contrast/a11y Playwright suites (`src/routes/contrast.e2e.ts` 'alerts', `e2e/a11y.e2e.ts`) run under the node server, where desktop_only_driver hides the Desktop card. The new card is never put through axe or the contrast check. The risk is low because it reuses the existing `.channel`/`sendMe`/`channelState` snippets.
- [strength] Startup ordering is analysed correctly. adapter-node runs the Kit `init` hook (scheduler start, first pass) during the handler import. So the notifier must be published before the import (t-7 contract via fake-handler, and t-10's fresh-install card as an end-to-end double check), the AUMID must be set before `startServer` (t-7), and a click can arrive before lifecycle is ready (held, latest wins) or before `setClickHandler` (buffered in t-5). All three are pinned.
- [strength] Test contracts are unusually concrete: the off-origin path table for `showWindow` (`//evil.example/x`, `/\\evil.example`), `vi.getTimerCount()` being 0 after a 'show' so a settle timer cannot hold quit, the retained-notification cap (25 → 20), `encodeURIComponent` on a watch id `'a/b?c'`, and "desktop failure isolated" proving ntfy is neither re-sent nor blocked. Each names the exact behaviour that breaks.
- [strength] Grounded in the real repo. Every file referenced exists or is created by an earlier task. `notify_channel.kind` really is a plain-text PK with no CHECK, so no migration is needed. The ntfy.spec `Record<FailureReason,string>` table really would break `pnpm check`. guard.e2e is the only desktop e2e that asserts stored channel kinds. `checkNow` on the watch page really does wire `liveAfterFailure`.

## Summary
The plan is sound and can proceed. Coverage, locked decisions and rules are clean; the flags are about one knowingly-red desktop e2e window (t-8 → t-10), an unspecified failure path for the init seed, and three over-threshold tasks (t-2, t-7, t-9) the author may choose to split.
