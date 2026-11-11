# Plan Review — 01-public-ci

Reviewed: 2026-11-11
Plan: 7 tasks across 5 waves

## BLOCKING

- [antipattern / infeasible-as-written] t-4 + t-6 + t-7: the gitleaks job scans every ref, and red proof (b) is "reverted". That combination leaves gitleaks permanently red.
  `gitleaks git` with no `--log-opts` scans all refs (`--all`), and `actions/checkout` with `fetch-depth: 0` fetches every branch on origin. I checked this in a scratch repo where a random fake key existed only on a side branch: running on `main`, `gitleaks git` exited 1, and `gitleaks git --log-opts=HEAD` exited 0. So t-6(b) breaks things two ways. First, a `git revert` keeps the fake key in the probe branch's history, so every later push to the probe fails gitleaks. That makes t-6 contract 1 ("all five success on the final head") and t-7 contract 4 ("all checks going green") impossible to meet. Second, for as long as `ci-probe/01-public-ci` exists on origin, gitleaks fails on every other PR in the repo too.
  Suggestion: in ci.yml, scope the scan to the history of the PR's merge commit with `gitleaks git --log-opts=HEAD --config .gitleaks.toml --redact --no-banner --exit-code 1`. That is still the full history of the code under review, so c-3 still holds. In t-6, undo red proofs (b), and preferably (a) and (c) too, with `git push --force-with-lease` back to the SHA from before the proof, not with `git revert`. Then state that the history of the probe's final head contains no proof commits.

- [test-contract] t-7 contract 4 reads `mergeStateStatus` on a draft PR. GitHub reports `DRAFT` for a draft PR, never `BLOCKED`, so neither half of the contract can be observed as written. Run that way, it either produces a false red or invites a fudge.
  Suggestion: in t-7, run `gh pr ready <probe>` before the merge-gating proofs and put it back with `gh pr ready --undo` before closing. Pair the result with `gh pr checks --required` for the same head SHA. Also note that the viewer is an admin with bypass, so cross-check against the ruleset read-back (contract 1) and don't rely on `mergeStateStatus` alone.

## FLAG

- [test-contract / tooling] t-5: `repo-hygiene.spec.ts` built on `git ls-files` will fail inside Stryker's sandbox. That breaks the initial dry run of every `dross verify` mutation run.
  `stryker.config.json` sets `tempDirName: ".stryker-tmp"`, which sits inside the repo and is gitignored (`.gitignore`: `.stryker-tmp/`). In a scratch repo with the same layout, running `git ls-files` from inside the ignored sandbox directory returned `count=0`. The plan's own "scans the tree" guard (contract 3) then fails. `vitest.stryker.config.ts` runs the whole 'server' project, which after t-2 includes `scripts/**`.
  The same spec also matches itself: `scripts/repo-hygiene.spec.ts` and `scripts/readme.spec.ts` (t-3) both have to contain the literals `Dockerfile` / `image-smoke` / `compose`, and neither file is in the exclusion list (.dross/, pnpm-lock.yaml, fixtures).
  Suggestion: resolve the root with `git -C <import.meta.dirname> rev-parse --show-toplevel` and run `git -C <root> ls-files`. Exclude the two spec files explicitly, or build the forbidden strings so they cannot match themselves. Add both points to the t-5 description.

- [locked-decision interaction] t-7 vs locked `protection_bypass`. The decision assumes the admin "pushes dross chores directly", but dross does not route chores that way. `~/.claude/dross/prompts/ship.md:70` and `quick.md:21` send chores through an auto-merge chore PR whenever `dross protect --check <base>` reads `protected`. `protect.go` `protectCheck` returns `protected` for any branch where a PR is required, regardless of bypass.
  Main gets no ci.yml until milestone v0.1 merges. Until then, any chore PR or quick-task PR into main waits forever on five required checks that never report. Admin bypass is the only way out, and it is manual.
  `dross doctor` will also permanently report "admin bypass allowed" (`~/Development/dross/internal/protect/assess.go:86`). Milestone chore PRs, which `milestone.md:148` says "usually merge at once", will now wait for the full 3-OS matrix.
  Suggestion: the decision stays as it is, but surface this consequence to the user before t-7. Add a t-7 note on how to unstick a main chore PR (`gh pr merge --admin`), and say that `dross doctor` will flag the bypass by design.

- [infeasible detail] t-7: the ruleset bodies leave out fields that decide whether a solo repo can merge at all, and they have no names.
  dross's own builder (`~/Development/dross/internal/protect/ruleset.go:66-72, 84-95`) sends `require_extra_approval_for_unattributed_changes: false` because GitHub defaults it to true on the server. With it true, a PR holding a commit not attributed to a GitHub account needs one approval, which a solo author cannot give. dross also sends `allowed_merge_methods: ["merge","squash"]`: phases squash into the milestone, the milestone merges into main as a merge commit, and chore PRs merge as merge commits. The plan's "PUT when a ruleset of that name already exists" needs a name, and none is given. Reusing `dross: main` / `dross: milestones` means a later `dross protect --apply` would reset `bypass_actors` to `[]`. Picking other names means that apply would create duplicates.
  Suggestion: set the names explicitly in main.json and milestone.json. Include all the required pull_request parameters, with unattributed-approval false and merge+squash allowed. Note in t-7 that `dross protect --apply` must not be run against this repo while `protection_bypass` stands.

- [antipattern] t-4: on Windows runners `run:` defaults to `pwsh`. The pwsh wrapper only propagates the exit code of the last native command, so a multi-command step can hide an earlier failure. That conflicts with c-1's "any failing step fails the check".
  Suggestion: set workflow-level `defaults: run: shell: bash` (Git Bash is on the Windows images), or require exactly one command per `run:` and add a contract that checks it.

- [coverage] t-6 / c-1 and c-4: both criteria name `main`, but every live proof runs on a PR into `milestone/v0.1`. Nothing exercises the `main` entry in the `pull_request.branches` filter.
  Suggestion: in t-6, also open a second draft probe PR into `main` from the same probe head, see that all five checks run, then close it. Retargeting an existing PR does not fire a `pull_request` run by default.

- [files] t-2: `tsconfig.json` is missing from the file list. Its `include` is `["src", "vite.config.ts", "playwright.config.ts", "drizzle.config.ts"]`, so `pnpm check` will not typecheck `scripts/**`. The description defers this to "say so in the task notes if it does not". It is a one-line fix, and four new spec files depend on it.
  Suggestion: add `"scripts"` to `include` and add `tsconfig.json` to t-2's files.

- [test-contract] t-2: the CLI exit behaviour (contract 5) is only testable by spawning `node`. Stryker's `perTest` coverage cannot attribute a child process, so the CLI mutants come out as NoCoverage or survivors, and under `dross-survivor-drain` those must be routed or accepted. Separately, the description says to "Test both: empty list rejects; a listed workflow passes only for its listed scope" for `WRITE_SCOPE_ALLOWLIST`, but no test_contract covers it.
  Suggestion: export a `runPolicy(dir): { violations, exitCode }` and test it in-process, leaving the bootstrap line that calls `process.exit` as the only untested code. Add a contract for the allowlist hook. The hook is also prep for 05-release, beyond c-5. That is acceptable only because it ships empty.

- [CI hardening checklist] t-4 neither adopts nor defers item N3 of `reference_ci_supply_chain_hardening.md` (the audit gate). The global CLAUDE.md requires surfacing every checklist gap. The other Node items are met: exact Node via `.node-version` (24.14.0, matches local `node --version`), exact pnpm via `packageManager`, a frozen lockfile, and pnpm 10's default denial of build scripts standing in for `--ignore-scripts`.
  Suggestion: have the user decide either to add `pnpm audit --audit-level=high --prod`, scoped per `reference_ci_pipeline_optimisation.md` §11 (lockfile-change PRs plus a weekly `schedule`), or to record it in `.dross/deferred.toml`.

## NOTE

- [t-4] The plan doesn't say where the gitleaks tarball's sha256 comes from. Per global rule 6, take it from that release's `gitleaks_8.30.1_checksums.txt` and compare it with `shasum -a 256` of a local download, never from memory. The Playwright browser cache path differs by OS (`~/.cache/ms-playwright`, `~/Library/Caches/ms-playwright`, `%LOCALAPPDATA%\ms-playwright`). Set `PLAYWRIGHT_BROWSERS_PATH` once, or the cache step will only work on one OS.
- [t-1] Contract 1 scans committed history only, so `.gitleaks.toml` itself, which holds regexes pinned to the fake values, is not scanned until CI does it. Add a `gitleaks dir --config .gitleaks.toml --redact` over the tree, with `.env` excluded, before committing. The values are test constants in public spec files, so reading the source lines to pin them is fine. "Report fields only" applies to the reports, not to the source.
- [locked os_matrix] `static` and `gitleaks` run on Linux only, and only the `test (…)` jobs fan out to three OSes. That reading of "the PR gate runs on Linux, macOS and Windows" is defensible because lint, check and gitleaks don't depend on the OS. It is recorded here so the reading is explicit.
- [strength] The finding inventory is exact. My redacted `gitleaks git` (8.30.1) returns the same 10 findings at the same file:line pairs, all in faff963. In all three fixture hits the match contains `k-closure-key`, so `regexTarget = "match"` with condition AND works as described.
- [strength] The repo claims check out. `git ls-files --eol` gives 235 `i/lf` and 3 `i/none`, so `.gitattributes eol=lf` renormalises nothing. `dross protect` (preview) fails with "no required checks — the repo's pull_request workflows declare no jobs", which confirms the reason for hand-rolled rulesets. `integration_id` 15368 is the GitHub Actions app. The `.dockerignore`/Docker reference list in t-5 (ARCHITECTURE.md:69/162/165, cli headers, health.ts:10) matches `git grep`.
- [strength] The cost and gating structure is sound. The cheap `static`/`gitleaks` jobs gate one merged unit+e2e job per OS, and the matrix names `test (${{ matrix.name }})` keep the required-check contexts stable when runner images change. Because `static` and `gitleaks` are themselves required, a skipped `test (…)` (which GitHub counts as passing) cannot let a red PR merge.

## Summary

The plan covers all seven criteria and respects the locked decisions. Two contract defects make t-6 and t-7 impossible to complete as written: the all-refs gitleaks scan combined with reverting the proof, and `mergeStateStatus` read on a draft PR. Fix those, plus the t-5 Stryker-sandbox/self-match issue and the t-7 ruleset body, before executing.
