# mvp draft — 06-remediate-security

Lens: smallest task set that satisfies all 27 criteria. Same-area fixes are merged. Waves exist only where a task needs another task's output.

```
Phase 06-remediate-security — 14 tasks across 5 waves

Wave 1
  t-1  Bump Kit and adapter-node, ignore audit dir
       files:    package.json, pnpm-lock.yaml, .gitignore, scripts/repo-hygiene.spec.ts
       desc:     @sveltejs/kit -> ^3.1.1 and @sveltejs/adapter-node -> ^6.0.1, lockfile regenerated
                 (frozen install observed clean). @electron/fuses (already 1.8.0 transitively) becomes an
                 exact devDependency so t-12 can import it under pnpm's strict layout. .gitignore gains
                 /.dross/security/.
       covers:   c-12, c-17
       contract: - if pnpm-lock.yaml resolves @sveltejs/kit below 3.1.1 or @sveltejs/adapter-node below
                   6.0.1, repo-hygiene.spec 'shipped framework floors' fails (it parses the lockfile's
                   package keys, not package.json ranges)
                 - if `git check-ignore .dross/security/x/report.md` exits non-zero, repo-hygiene.spec
                   'raw audit findings are ignored' fails
                 - if @electron/fuses is missing from devDependencies or is not an exact x.y.z,
                   repo-hygiene.spec fails
       depends:  —

  t-2  Bind saved alert secrets to their destination
       files:    src/lib/server/alerts/smtp.ts, src/lib/server/alerts/smtp.spec.ts,
                 src/lib/server/alerts/ntfy.ts, src/lib/server/alerts/ntfy.spec.ts
       desc:     SMTP parse keeps a blank password only when host, port and username all match the saved
                 config. Otherwise it returns {ok:false} with a message asking for the password for the
                 new server. ntfy does the same for a blank token, keyed on the topic URL's origin.
                 ntfy parse also honours a clear_token form field: with a blank token it gives token null
                 and the channel stays. A typed token wins over clear_token. saveChannel already writes
                 nothing on a refusal.
       covers:   c-1, c-20
       contract: - if saved {host a.example, 587, user u, pw P} parsed with a blank password and host
                   b.example, port 465 or username v (each alone) gives ok:true, smtp.spec 'secret bound
                   to destination' fails
                 - if the same host/port/username with a blank password does not give config.password ===
                   P, or send() on that config does not AUTH with P against the fake transport,
                   smtp.spec 'blank keeps the secret' fails (c-20)
                 - if saved {url https://a.example/t, token T} with a blank token and topic
                   https://b.example/t (or http://a.example/t, or https://a.example:8443/t) gives
                   ok:true, ntfy.spec 'write-only token' fails (the existing 'even when the topic
                   changes' case at ntfy.spec:328 is inverted)
                 - if https://a.example/other-topic with a blank token does not keep T (same origin),
                   ntfy.spec fails (c-20)
                 - if {topic same, token '', clear_token 'on'} does not give token null with ok:true, or
                   {token 'tk_new…', clear_token 'on'} does not give token 'tk_new…', ntfy.spec fails
                 - if any refusal message contains the saved password or token sentinel, either spec fails
       depends:  —

  t-3  Gate desktop server with a per-launch cookie
       files:    src/desktop/server.ts, src/desktop/server.spec.ts, src/desktop/main.ts,
                 e2e/desktop/guard.e2e.ts
       desc:     startDesktopServer({handler, secret}) answers 403 after the Host check and before
                 adapter-node/sirv, unless the request is exactly GET /health or carries cookie
                 pc_session=<secret> (constant-time compare). main makes 32 random bytes per launch and
                 awaits session.defaultSession.cookies.set({url: origin, httpOnly, sameSite:'strict'})
                 in startServer, before any showWindow/loadURL. loadAdapterHandler deletes
                 ALERTS_ENCRYPTION_KEY from process.env once the handler import (and so Kit's init) has
                 resolved. No gate under pnpm dev.
       covers:   c-3, c-13
       contract: - if a request with no cookie, a wrong cookie or a same-length wrong secret reaches the
                   handler for GET /, GET /account/alerts/__data.json, GET /_app/immutable/x.js or POST
                   /account/alerts?/save, server.spec 'session gate' fails (handler spy called)
                 - if GET /health without the cookie is not passed through, or HEAD /health or POST
                   /health is, server.spec fails
                 - if process.env.ALERTS_ENCRYPTION_KEY is still set after loadAdapterHandler resolves
                   (fake module records that it saw the key at import), server.spec 'key leaves
                   process.env' fails
                 - if a cookie-less rawRequest to /account/alerts/__data.json returns anything but 403, or
                   its body contains the seeded topic, or any of save/test/remove/add/delete/check
                   returns anything but 403 and changes the DB, guard.e2e 'no launch cookie, no access'
                   fails
                 - if the window's own form posts stop reaching their actions, the existing guard.e2e
                   "the window's own form posts reach their actions" fails (c-3 window unchanged)
                 - if main's process.env holds ALERTS_ENCRYPTION_KEY after the window is up,
                   guard.e2e 'main env holds no key' fails; if the key is removed before Kit's init read
                   it, the server refuses to start and every desktop e2e fails at launch
       depends:  —

  t-4  Add Origin check, frame headers and CSP
       files:    src/lib/server/local-request.ts, src/lib/server/local-request.spec.ts, vite.config.ts,
                 e2e/desktop/launch.ts, e2e/local-guard.e2e.ts
       desc:     createLocalRequestHandle also refuses any non-GET/HEAD request whose Origin header is
                 missing or not event.url.origin with 403, independent of Kit's dev-only CSRF skip. It
                 sets X-Frame-Options: DENY on every resolved response. kit.csp {mode:'auto'} sets
                 script-src 'self', img-src 'self' plus m.media-amazon.com,
                 images-na.ssl-images-amazon.com and images-eu.ssl-images-amazon.com, frame-ancestors
                 'none', object-src 'none' and base-uri 'self'. The desktop e2e launcher records every
                 CSP violation on the window and fails the test on any.
       covers:   c-5, c-6, c-23
       contract: - if the handle passes POST /account/alerts?/save with Origin https://evil.example, with
                   Origin null or with no Origin (no dev flag involved: the handle cannot see one),
                   local-request.spec 'own origin check' fails (c-5 holds under pnpm dev too)
                 - if a same-origin POST, or a GET with a foreign Origin, is refused, local-request.spec
                   fails
                 - if a resolved response lacks X-Frame-Options: DENY, local-request.spec fails
                 - if GET / or a 404 page on the preview build lacks frame-ancestors 'none' in
                   Content-Security-Policy, or its script-src contains 'unsafe-inline' or any
                   scheme/host source, or its img-src allows anything beyond 'self' and the three Amazon
                   hosts, local-guard.e2e 'security headers' fails
                 - if any desktop e2e page logs a CSP violation (securitypolicyviolation, or a console
                   "Refused to" CSP line), launch.ts's teardown assertion fails that test
       depends:  —

  t-5  Claim check-now cooldown, make normalise linear
       files:    src/lib/server/checks.ts, src/lib/server/checks.spec.ts, src/lib/nav.ts, src/lib/nav.spec.ts
       desc:     checkNow claims the watch in a module-level Map<watchId, attemptAt> synchronously
                 before its first await. A claim or lastCheckedAt inside CHECK_COOLDOWN_MS refuses with
                 the cooldown result. The claim stays after a failed fetch, so cooldown runs from the
                 attempt. nav.ts normalise trims trailing '/' with an index loop and no regex.
       covers:   c-4, c-21, c-16
       contract: - if two checkNow calls on one watch started in the same tick, with a deferred fetch,
                   give two 'checked' results or call the shop fetch twice, checks.spec 'concurrent
                   check-now' fails
                 - if a checkNow whose fetch fails is followed by an immediate checkNow that is not
                   'cooldown', checks.spec fails (c-21)
                 - if a checkNow at failed-attempt + CHECK_COOLDOWN_MS (injected now) is refused, or one
                   at + CHECK_COOLDOWN_MS - 1 ms runs, checks.spec fails
                 - if normalise('/a' + '/'.repeat(16384) + 'x') takes 10 ms or more (best of 5 runs on
                   plain Node), nav.spec 'linear trailing-slash trim' fails
                 - if '/', '', '/account/alerts/', '/account/alerts///', '///' or '/watches/1' give
                   different navItems than today, nav.spec's table fails
       depends:  —

  t-6  Scope bot-wall text, upgrade short links
       files:    src/lib/server/shops/amazon/classify.ts, src/lib/server/shops/amazon/classify.spec.ts,
                 src/lib/server/shops/amazon/short-link.ts, src/lib/server/shops/amazon/short-link.spec.ts
       desc:     The BOT_WALL_TEXT phrases only count on a page with no #productTitle. The
                 validateCaptcha form check still counts on any page. resolveShortLink rewrites an
                 http: amzn.to or amzn.eu URL to https: before each request, the first hop and every
                 redirect hop alike. Fixtures are edited in memory only: no new fixture file and no live
                 fetch (r-01).
       covers:   c-7, c-14
       contract: - if recorded-plain.html with "Click the button below to continue shopping." injected
                   into a review body, or "make sure you're not a robot" into #feature-bullets, does not
                   classify ok, classify.spec 'phrase in product content' fails
                 - if any manifest fixture tagged wall/captcha (recorded-captcha-continue,
                   synthetic-captcha) stops classifying blocked, the existing fixtures.spec/classify.spec
                   wall cases fail
                 - if resolveShortLink('http://amzn.to/abc') makes any client.request whose URL starts
                   'http:', or a 301 Location 'http://amzn.eu/xyz' is then requested over http,
                   short-link.spec 'never plaintext' fails (fake client records URLs)
       depends:  —

  t-7  Wrap alerts key with Electron safeStorage
       files:    src/desktop/alerts-key.ts, src/desktop/alerts-key.spec.ts, src/desktop/main.ts
       desc:     loadOrCreateAlertsKey(file, safeStorage?) uses a structural, type-only SafeStorage. With a
                 real backend (isEncryptionAvailable() and, on Linux, a backend that is not basic_text)
                 a new key is written wrapped ('safeStorage:v1:' + base64 of encryptString). An existing
                 raw v0.1.5 key is rewritten wrapped through temp, fsync and rename, and only after a
                 decrypt round-trip matches. Any failure keeps the raw file and logs the error class
                 only. main passes Electron's safeStorage.
       covers:   c-24, c-25
       contract: - if a fresh key with a real-backend fake leaves file bytes that parse as raw base64-32,
                   or lack the prefix, alerts-key.spec 'wrapped at rest' fails
                 - if a backend of 'basic_text' (linux) or isEncryptionAvailable false writes anything but
                   the raw 0600 file, alerts-key.spec fails
                 - if a pre-existing raw key file is not rewritten wrapped on load, or the returned key
                   Buffer differs from the original bytes (so channels sealed under it would not decrypt),
                   alerts-key.spec 'v0.1.5 migration' fails
                 - if encryptString throwing, or a round-trip mismatch, changes the raw file's bytes or
                   makes load throw, alerts-key.spec 'wrap failure keeps raw' fails
                 - if any thrown or logged text contains the key's base64, alerts-key.spec fails
       depends:  —

  t-8  Add env-gated main-process e2e hook
       files:    src/desktop/e2e-hook.ts (new), src/desktop/e2e-hook.spec.ts (new), src/desktop/main.ts
       desc:     installE2eHook({env, stdin, stdout, commands}) does nothing unless
                 PRICE_CHECK_E2E_MAIN_HOOK is set at launch. main reads the variable before
                 loadAdapterHandler swaps process.env. When set, it answers JSON-line requests on stdin
                 from a fixed command table: pid, appInfo (isPackaged, userData, version, platform,
                 arch), sharedObjects, updater status/restart/checkNow via the published handle, login
                 item off, quit. There is no eval and no socket.
       covers:   c-27
       contract: - if install with an env lacking PRICE_CHECK_E2E_MAIN_HOOK attaches any stdin listener
                   or writes to stdout, e2e-hook.spec 'inert without the env var' fails
                 - if e2e-hook.ts (source ?raw) imports node:net, node:http, node:https, node:inspector,
                   node:dgram or electron's net, or contains eval( / new Function / .listen(,
                   e2e-hook.spec 'never a network listener' fails
                 - if an unknown command, or a request carrying a code string, does anything but reply
                   {error:'unknown command'}, e2e-hook.spec fails
                 - if {cmd:'appInfo'} over a fake stdin does not reply with the id echoed and the five
                   fields, e2e-hook.spec fails
       depends:  —

  t-9  Lock v* tags, check live repo settings
       files:    .github/rulesets/release-tags.json (new), scripts/rulesets.spec.ts,
                 scripts/repo-policy.ts (new), scripts/repo-policy.spec.ts (new), .github/workflows/audit.yml
       desc:     A tag ruleset on refs/tags/v* (creation, update, deletion) is bypassable only by
                 RepositoryRole 5 (admin). The executor applies it, enables immutable releases and
                 Dependabot alerts with gh api, then reads each back. repo-policy.ts (Node built-ins
                 only) GETs the live tag ruleset, release environment, immutable-releases and
                 vulnerability-alerts endpoints and exits 1 naming each one missing. audit.yml drops
                 --prod and gains a policy job, run on its schedule and on pushes to main, using a
                 read-only REPO_POLICY_TOKEN. Any build-only high advisory is ignored by GHSA in
                 pnpm-workspace.yaml auditConfig, with a comment.
       covers:   c-9, c-10, c-11
       contract: - if release-tags.json does not target tag refs/tags/v* with creation, update and
                   deletion rules, or has any bypass actor other than RepositoryRole 5, rulesets.spec
                   fails
                 - if repo-policy's checker passes a fake API with the tag ruleset absent, the release
                   environment lacking the v* tag-type policy, immutable releases disabled, or
                   vulnerability-alerts 404, repo-policy.spec fails (one case each, and the exit message
                   names the missing setting)
                 - if audit.yml's audit step still passes --prod, or no job runs node
                   scripts/repo-policy.ts, repo-policy.spec 'audit wiring' fails
                 - executor observes `node scripts/repo-policy.ts` exit 0 against the live repo before
                   committing (output in the task log, no token printed)
       depends:  —

Wave 2
  t-10 Add ntfy clear-token control and inline refusal  (depends t-2)
       files:    src/routes/account/alerts/+page.svelte, src/routes/account/alerts/page.svelte.spec.ts,
                 src/routes/account/alerts/alerts.e2e.ts
       desc:     The ntfy card shows a "Remove saved token" checkbox (name clear_token) when tokenSet. The
                 destination-change refusal from t-2 renders inline on its card through the existing
                 fail(400, {kind, message}).
       covers:   c-2
       contract: - if the ntfy card with tokenSet true lacks a clear_token checkbox, or shows one with
                   tokenSet false, page.svelte.spec fails
                 - if saving with clear_token ticked does not flip token-state to 'Access token: none.'
                   while the ntfy card stays listed, alerts.e2e 'clear token keeps channel' fails
                 - if changing the topic to another origin with a blank token does not show the refusal
                   inline and leave the saved topic unchanged on reload, alerts.e2e fails (c-1 UI path)
       depends:  t-2

  t-11 Drive packaged e2e without the inspector  (depends t-8)
       files:    e2e/packaged/launch-packaged.ts, e2e/packaged/smoke.packaged.ts,
                 e2e/packaged/update.packaged.ts
       desc:     launchPackaged spawns the exe itself (node:child_process) with
                 --remote-debugging-port=0 and PRICE_CHECK_E2E_MAIN_HOOK=1. It reads the DevTools
                 endpoint from stderr and connects chromium.connectOverCDP to the window. Every
                 app.evaluate becomes a t-8 hook command. _electron.launch and --inspect* are gone
                 from e2e/packaged.
       covers:   c-22
       contract: - if the spawned argv contains any /^--inspect/ arg, or the hook's appInfo shows
                   process.execArgv with one, smoke.packaged 'launched without the inspector' fails
                 - if e2e/packaged/*.ts still references _electron or app.evaluate, smoke.packaged's source
                   check fails
                 - if the hook cannot quit the app (exit status not 0 within QUIT_TIMEOUT_MS) or the
                   updater handle's status/restart are unreachable, the existing smoke and
                   update.packaged flows fail at that step
       depends:  t-8

Wave 3
  t-12 Turn on fuses, drop library-validation entitlement  (depends t-1, t-11)
       files:    scripts/package-desktop.ts, scripts/package-desktop.spec.ts,
                 build-resources/entitlements.mac.plist (new), scripts/verify-packaged.ts,
                 scripts/verify-packaged.spec.ts
       desc:     builderConfig.electronFuses sets runAsNode, enableNodeOptionsEnvironmentVariable,
                 enableNodeCliInspectArguments and grantFileProtocolExtraPrivileges false, and
                 enableEmbeddedAsarIntegrityValidation and onlyLoadAppFromAsar true. mac
                 entitlements/entitlementsInherit point at a plist with allow-jit only and no
                 disable-library-validation. A --sign-config <file> option writes
                 builderConfig({sign:true}) as JSON for t-13's signing job. verify-packaged gains
                 `fuses <exe>`, which reads the wire with @electron/fuses and lists every wrong fuse.
       covers:   c-8, c-22
       contract: - if builderConfig().electronFuses differs from the six required values in either sign
                   mode, package-desktop.spec 'fuses' fails
                 - if the entitlements plist contains com.apple.security.cs.disable-library-validation,
                   or mac.entitlements/entitlementsInherit do not point at it, package-desktop.spec fails
                 - if --sign-config writes JSON that differs from builderConfig({sign:true}) or contains
                   any CSC_/APPLE_ variable value, package-desktop.spec fails
                 - if verify-packaged `fuses` accepts a fake wire with RunAsNode, NodeOptions, CliInspect
                   or GrantFileProtocolExtraPrivileges on, or asar integrity or OnlyLoadAppFromAsar off,
                   verify-packaged.spec fails (one case each, naming the fuse)
                 - executor observes `pnpm package:desktop` then `verify-packaged fuses` exit 0, and
                   `pnpm test:e2e:packaged` pass on the host, before committing (c-19, c-22)
       depends:  t-1, t-11

Wave 4
  t-13 Split release signing into secret-only job  (depends t-12)
       files:    .github/workflows/release.yml, scripts/workflow-policy.ts, scripts/workflow-policy.spec.ts,
                 scripts/release-workflow.spec.ts, signing/package.json (new), signing/pnpm-lock.yaml (new)
       desc:     The build-macos job is secret-free: it packages the unsigned .app with --dir, writes
                 the sign-config and uploads both. A new sign-macos job (environment: release, the five
                 secrets) checks out only signing/ and installs it with --frozen-lockfile,
                 --ignore-workspace and --ignore-scripts (exact electron-builder, same version as root).
                 It runs `electron-builder --prepackaged … --config sign-config.json`, with trap 'rm -f
                 "$RUNNER_TEMP/AuthKey.p8"' EXIT set before the p8 is decoded. A secret-free
                 verify-macos job runs verify-packaged (layout, mac --signed, fuses) and the packaged e2e
                 on the signed artefact, then uploads release-macos. The Windows and Linux jobs gain a
                 verify-packaged fuses step. workflow-policy asserts the split and the trap.
       covers:   c-26, c-15, c-8 (released-app fuse check)
       contract: - if the job that references secrets.CSC_LINK, CSC_KEY_PASSWORD or APPLE_API_* has any
                   run step containing `pnpm install` without --dir signing, `pnpm build`, `pnpm test`,
                   `pnpm package:desktop` or `node scripts/`, or any step before checkout of a ref other
                   than the tag, `pnpm ci:policy` (workflow-policy.spec 'signing job isolation') fails
                 - if a step that writes AuthKey.p8 has no `trap … rm -f "$RUNNER_TEMP/AuthKey.p8"` EXIT
                   line before the decode line, workflow-policy.spec 'p8 cleanup' fails
                 - if any job other than sign-macos takes environment: release or references a release
                   secret, release-workflow.spec fails
                 - if signing/package.json's electron-builder is not exact and equal to root
                   package.json's, or signing/ has dependencies beyond electron-builder,
                   release-workflow.spec fails
                 - if the macOS, Windows or Linux path lacks a `verify-packaged.ts fuses` step before its
                   upload, release-workflow.spec fails
       depends:  t-12

Wave 5
  t-14 Re-audit and close SEC-01..17  (depends t-1..t-13)
       files:    .dross/security/state.toml (gitignored, not committed)
       desc:     Run /dross-secure on the phase branch. Mark each SEC id resolved, or dismissed with the
                 locked decision as the reason: SEC-12 per sec12_output_capture_seam, and SEC-14's
                 queue-cap half per sec14_queue_cap. Observe pnpm test:e2e:packaged and PR CI green on
                 macOS, Windows and Linux. Open pnpm dev in a browser: watchlist and alerts render,
                 one form post works, no CSP violation.
       covers:   c-18, c-19
       contract: - if the fresh run's reconcile reports any new finding at medium or higher, the task
                   fails (recorded from the run's report header)
                 - if any of SEC-01..17 in state.toml has a status other than resolved/dismissed, a
                   grep -c check of the 17 ids against status lines fails
                 - if pnpm test:e2e:packaged fails on any OS in PR CI, or the pnpm dev browser check
                   shows a CSP violation or a 403 on a same-origin form post, the task fails (c-19)
       depends:  t-1, t-2, t-3, t-4, t-5, t-6, t-7, t-8, t-9, t-10, t-11, t-12, t-13
```

## Coverage

| Criterion | Tasks |
|---|---|
| c-1 | t-2 (t-10 UI path) |
| c-2 | t-10 (parse half in t-2) |
| c-3 | t-3 |
| c-4 | t-5 |
| c-5 | t-4 |
| c-6 | t-4 |
| c-7 | t-6 |
| c-8 | t-12, t-13 |
| c-9 | t-9 |
| c-10 | t-9 |
| c-11 | t-9 (t-1 bumps the advisories it would flag) |
| c-12 | t-1 |
| c-13 | t-3 |
| c-14 | t-6 |
| c-15 | t-13 |
| c-16 | t-5 |
| c-17 | t-1 |
| c-18 | t-14 |
| c-19 | t-12 (host packaged e2e with fuses on), t-14 (all OSes + pnpm dev) |
| c-20 | t-2 |
| c-21 | t-5 |
| c-22 | t-11, t-12 |
| c-23 | t-4 |
| c-24 | t-7 |
| c-25 | t-7 |
| c-26 | t-13 (signing config emitted by t-12) |
| c-27 | t-8 |

27/27 covered.

## Judgment calls

- **Unrelated small fixes merged.** checks.ts and nav.ts share t-5, and classify.ts and short-link.ts share t-6. Kept separate, each would be a one-file task under 10 minutes. Rejected one task per SEC id: that gives about 20 tasks for the same diff.
- **The session cookie is set in main's startServer, not in window.ts.** One `cookies.set` awaited before the server handle returns comes before every loadURL. Rejected a per-window beforeLoad hook: it touches window.ts and its spec and protects nothing more.
- **The gate lives in the desktop node:http wrapper, not hooks.server.ts.** sirv serves /_app/immutable before the hooks run, and the locked decision exempts dev. Rejected a hook-level check: it misses static files and needs a dev bypass.
- **c-13 rides with c-3 in t-3.** Both edit server.ts, and the key scrub is three lines. Rejected a separate task that would conflict on the same file.
- **The c-5 Origin check sits in createLocalRequestHandle and refuses missing Origin too.** That matches Kit's production behaviour, so dev and build agree. Rejected a dev-only branch: two code paths for one rule.
- **frame-ancestors comes from kit.csp and X-Frame-Options from the handle.** Rejected setting a second Content-Security-Policy header in the handle: it would collide with Kit's.
- **The check-now claim is an in-memory Map in checks.ts.** It needs no migration and is a single process. Rejected a conditional UPDATE on last_checked_at: it would show "last checked" before any result exists and change what the scheduler treats as due.
- **The bot-wall phrase match is limited to pages with no #productTitle.** Rejected stripping review and bullet subtrees: that is a selector list that drifts with Amazon's markup, and a real wall page never carries a product title.
- **The main-process hook uses stdio JSON lines with a fixed command table and no eval.** It satisfies c-27 and closes the run-JS path again. Rejected a file mailbox, which is slower and racier, and an eval channel, which would reopen what the CLI inspect fuse closes.
- **Fuses go in wave 3 after the harness rework.** Committing them first would turn the packaged e2e red (CliInspect off breaks _electron.launch). This is the one wave I added for commit-gate reasons, not output dependency. c-19 is its gate.
- **Signing uses an emitted JSON sign-config and an isolated signing/ manifest.** The secret job runs no project code at all, only electron-builder from its own frozen lockfile. Rejected running package-desktop.ts in the signing job: it is project code and needs the root install.
- **t-13 has 6 files.** Two of them are one manifest plus its lockfile, all in the release-CI layer. Splitting the policy assertions from the workflow edit would leave a commit where release.yml and its pinning spec disagree.
- **c-11 drops --prod rather than adding a shipped-deps filter script.** Build-only high advisories are ignored by GHSA in pnpm-workspace.yaml if any exist. Rejected a custom audit filter: it is more code than the criterion needs.
- **Blocker to flag to the coordinator:** the c-9, c-10 and c-11 live-settings check needs a read-only admin-scope token. GITHUB_TOKEN has no administration permission, so the immutable-releases and vulnerability-alerts endpoints are unreachable with it. You (Michal) must create REPO_POLICY_TOKEN (fine-grained, Administration: read, Metadata: read). The check runs on schedule and on pushes to main, not on fork PRs.
- **Three wave-1 tasks edit src/desktop/main.ts:** t-3 (startServer), t-7 (loadKey) and t-8 (hook install before the env swap). The regions are disjoint and none needs another's output, so they stay in wave 1. Rejected chaining them into waves, which would serialise for a merge-conflict risk the executor handles by running tasks in sequence.
- **safeStorage on macOS CI.** Unit tests use a fake safeStorage. No packaged-e2e assertion on the wrapped file was added (it would be a fourth edit to smoke.packaged.ts). Risk: a CI keychain prompt would surface as a packaged-e2e timeout in t-12 or t-14, not silently.
