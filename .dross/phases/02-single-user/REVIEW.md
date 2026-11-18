# Plan Review — 02-single-user

Reviewed: 2026-11-12
Plan: 13 tasks across 7 waves

## BLOCKING
(none)

All 7 criteria are covered (c-1: t-4/t-5/t-6/t-10/t-13; c-2: t-8/t-9/t-13; c-3: t-7/t-12; c-4: t-3/t-11; c-5: t-1/t-4/t-5/t-13; c-6: t-12; c-7: t-2/t-6/t-12). No task contradicts a locked decision. No task implies a hard-rule violation: r-01 is explicitly honoured in t-5, t-12 and t-13 (fake shop / `.invalid` host / direct createDb inserts), runtime.mode is native so `pnpm remove` in t-8 is fine, and no task commits real ntfy topics (r-03). Every file the plan references exists in the repo or is created by an earlier or the same task.

## FLAG
- [wave-order / commit gate] t-9 removes `signIn`, `submitLogin` and the `SEEDED_<user>` credentials from `e2e/accounts.ts`. Eight `src/routes/*.e2e.ts` files still import them, and tsconfig `include` covers `src`, so `pnpm check` goes red at t-9 and stays red until both t-10 and t-11 land. The plan accepts this, but it is longer than "until wave 7": t-12 and t-13 are also wave 7 and depend only on t-6/t-9, so if either commits before t-10 and t-11 its commit is red too. If the execute gate runs `runtime.typecheck_command` (`pnpm check`), t-9 cannot commit at all.
  Suggestion: keep the doomed exports in `e2e/accounts.ts` through t-9 and delete them in whichever of t-10/t-11 runs last. The alternative is to make t-12 and t-13 depend on t-10 and t-11, so that only t-9's commit is red.

- [granularity] t-4 (25 files: migration, schema, crypto/channels/alerts libs, hooks, the alerts route server and its Svelte page) and t-5 (21 files: migration, schema, watches/checks/sparklines libs, two route servers) both exceed the 5-file and 3-layer thresholds. The author's coupling argument holds. Dropping `user_id` breaks every caller and spec in the same commit, and `loginEmail` removal couples `+page.server.ts` to `+page.svelte` through the generated types. The weak point is the stated fallback, "merging with t-5", which would create a ~45-file task, the worst outcome for review and for bisecting.
  Suggestion: keep the split as planned. Change the recorded fallback from "merge with t-5" to splitting t-4 by layer: schema + migration + libs first, with the route and page following inside the same wave.

- [test-contract] t-11 lists `src/routes/focus.e2e.ts` and `src/routes/layout.e2e.ts`, and its description says "the footer link joins the focus-order … checks". None of its three contracts says what breaks in either file. focus.e2e and layout.e2e can be edited, or reduced to nothing, without any contract failing.
  Suggestion: add one contract line per file. For example: "if the Source link is not reached by Tab after the last main-content control on '/', focus.e2e fails". Also state what layout.e2e still asserts once login/admin rows are gone, or drop it from `files` if it only loses rows.

- [files] `ARCHITECTURE.md:57` documents "`pnpm admin:create` creates the first admin on a fresh instance". t-8 deletes that script and cleans README and `.env.example`, but no task touches ARCHITECTURE.md, which mentions auth/login/admin 12 times. After this phase the architecture doc describes a command and an access model that no longer exist. The ARCHITECTURE debt deferred in commit c052445 covers unresolved links, not content that becomes false.
  Suggestion: add ARCHITECTURE.md to t-8's `files` and its readme.spec contract, or record an explicit deferred item so the drift is tracked rather than silent.

## NOTE
- [coverage] t-1 claims c-5, but its contracts only prove harness isolation and migration-folder correctness. c-5 is actually proven by t-5's `restart keeps data` and `idempotent restart` contracts and by t-13's restart.e2e. That is harmless, but t-1 should not be counted as c-5 evidence at verify time.

- [locked-decision] The data_scope upgrade path keeps rows but not readability. t-4 changes `channelAad` to `['alert-channel', kind]`, so any channel sealed under the old per-user AAD is flagged undecryptable and skipped (contract: channels.spec). t-4's migrate.spec "identical counts and ids" check therefore passes while every pre-0009 channel stops sending. This is consistent with the locked decision and the milestone non-goal (no existing installs, no import), but anyone running a 0008 DB, such as a developer's `local.db`, will see their alert channels go dead silently.

- [locked-decision] Multi-user rejection only fires on a collision: two users with the same channel kind (t-4) or the same (shop, product_id) (t-5). A multi-user DB without collisions migrates and merges both users' data into one install. This satisfies "Multi-user DBs are unsupported" and is recorded only so nobody reads the rejection tests as a general multi-user guard.

- [files] `src/lib/server/health.ts:15` has a comment, "The filter drops the relations auth.schema.ts also exports", that goes stale once t-7 deletes auth.schema.ts. No contract catches it, because t-8's text scan matches `better-auth`/`BETTER_AUTH_SECRET`, not `auth.schema`. This is cosmetic.

- [wave-order] e2e has no signal from t-4 through t-9 (six commits), because `e2e/seed.ts` imports `alertChannel` (dropped in t-4) and `createAuth` (deleted in t-7). The plan acknowledges this, and neither file is under tsconfig `include`, so `pnpm check` stays green until t-9. Unit coverage in t-4 to t-8 is dense enough to carry that window.

- [strength] t-2's reject table is adversarial in the right places: look-alike hosts (`localhost.evil.example`, `127.0.0.1.nip.io`, `evil.com:localhost`, `user@localhost`, a comma-joined list). It also includes a test that fails if the handle reads `event.url` (built from ORIGIN by adapter-node) instead of the Host header. A startsWith/includes implementation cannot pass it.

- [strength] t-12 closes the "any action" quantifier in c-6 structurally. `action-endpoints.spec` fails if a `+page.server.ts` declares an action that is missing from `ACTION_ENDPOINTS`, or if `vite.config.ts` loosens csrf. The ORIGIN-unset run with a foreign Host + foreign Origin isolates the Host guard as the only thing that can return 403.

- [strength] The migration contracts check identical ids and row counts across each upgrade, with no cascade loss through the table rebuilds. They require multi-user DBs to be rejected and left at the previous migration, and t-7 adds a "schema matches snapshot / db:generate emits nothing" check. Together these catch the usual drizzle-kit SQLite rebuild failures (FK cascade on table recreate, journal `when` skew) before they ship.

## Summary
The plan covers every criterion, respects all three locked decisions and has unusually specific contracts. Proceed after fixing the t-9 `pnpm check` red window (and how t-12/t-13 relate to it) and the missing focus/layout contracts in t-11.
