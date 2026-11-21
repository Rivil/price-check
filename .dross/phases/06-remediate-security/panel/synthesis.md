# Panel synthesis — 06-remediate-security

Judge's repo checks (read-only, 2026-11-20). They shaped the grafts below:

- `scripts/gitleaks-config.spec.ts` 'every phase allowlisted' is **red on this branch today**. 06 has a spec.toml, and `.gitleaks.toml` lists tests.json paths for 01–05 only. Only the verification draft noticed this.
- `e2e/desktop/harness.e2e.ts:111` 'launcher env' asserts that main's `process.env` **holds** ALERTS_ENCRYPTION_KEY. c-13 flips it. Only the risk draft noticed this.
- `e2e/packaged/smoke.packaged.ts:173` ('x64 slice') and `update.packaged.ts:637/731` make **cookieless** `rawRequest`s and expect 200 plus the watch title. The c-3 gate turns them red until the packaged harness is reworked. Only the risk draft's design (hook `appGet`) handles this, and no draft names the red window.
- `src/lib/assets/favicon.svg` is 590 bytes, under Vite's 4096-byte inline limit, so it ships as a `data:` URI that `img-src 'self'` blocks. Only the risk draft noticed this (`assetsInlineLimit 0`).
- `ntfy.spec.ts:324` 'write-only token' pins keep-on-any-topic behaviour, which c-1 inverts. All drafts name this.
- `short-link.ts` sends every Location hop back through `normaliseAmazonUrl`, so forcing https in url.ts covers every hop. The verification draft's claim holds.
- `@electron/fuses@1.8.0` is already in pnpm-lock.yaml through electron-builder. `audit.yml:34` runs `pnpm audit --audit-level=high --prod`. `release.yml` already runs `verify-packaged mac --signed`.
- CI runs the desktop e2e on linux, macos and windows, so a desktop-e2e safeStorage proof reaches real DPAPI on Windows.

## Scores

| Dimension | risk | mvp | verification |
|---|---|---|---|
| Criteria coverage | 27/27. Every criterion has an owner per failure mode. Misses the red gitleaks spec. | 27/27 on paper. c-11 is met by dropping `--prod` plus a GHSA ignore list. c-24/c-25 have fake-backend unit tests only. The harness.e2e 'launcher env' flip is unseen. | 27/27. Finds the red gitleaks spec and adds a fuses step to CI and release. Misses the harness.e2e 'launcher env' flip and the data: favicon. |
| Test-contract specificity | Sharpest. Named inputs, fail-closed cases, secret sentinels, and liveness controls (stock Electron binary, injected inline script). | Mixed. Several sharp lines (ntfy.spec:328 inversion, sentinels), but some are generic ("the existing smoke and update flows fail at that step", "every desktop e2e fails at launch"). | Sharp. Each gate is stated red-before and green-after, the collector has a liveness control, and the live settings are observed going red then green. |
| Granularity | 25 tasks, mostly right-sized. The 6-file gate wiring task gives a reason. nav and .gitignore are bundled without a link. An extra in-repo fuse-parser task. | 14 tasks, over-bundled. t-4 is Origin + XFO + CSP + collector, t-9 is ruleset + live check + audit wiring, and t-13 has 6 files. | 23 tasks, mostly right-sized. t-1 (6 config files) and t-7 (url + nav) are bundles. |
| Wave correctness | Fuses land in wave 1, so the packaged e2e is knowingly red for 3 waves. The ruleset is applied before its check exists, so there is no red-to-green proof. Some depends follow file ownership, not output. | Gate (W1) before harness (W2) leaves the packaged raw requests red. Three main.ts edits share W1. Fuses come after the harness, which is right. | Server gate t-8 (W2) lands a wave before the window cookie t-16 (W3), so the commit between them 403s the app's own window. Otherwise it orders the two hardest gates correctly (harness before fuses, check before apply). |

**Skeleton: verification.** Its task cut and wave order already match what the merged plan needs: t-1 first, because of an observed red test; the hook module separate from its main wiring; harness proven on default fuses before the flip; the settings check before the apply; and a CI fuses step on 3 OSes. Its one structural flaw is the half-gated commit, and the risk draft's gate split fixes it. Most of the contract sharpening also comes from the risk draft.

## Merged plan

```
Phase 06-remediate-security — 25 tasks across 7 waves

Workflow-editing tasks (t-14, t-19, t-21, t-24): before editing, the executor reads
~/.claude/memory/reference_ci_supply_chain_hardening.md and audits the file against it
(CLAUDE.md CI hygiene). Nothing is reported green that was not run in that task.

Wave 1
  t-1  Lift Kit floors, allowlist 06, ignore audits                     [verification+risk+mvp]
       files:    package.json, pnpm-lock.yaml, .gitleaks.toml, .gitignore,
                 scripts/lockfile.spec.ts (new), scripts/repo-hygiene.spec.ts
       desc:     @sveltejs/kit ^3.1.1, @sveltejs/adapter-node ^6.0.1, @electron/fuses as an
                 exact devDependency (already 1.8.0 transitively; t-12 imports it — see D3).
                 The only task that regenerates pnpm-lock.yaml. .gitleaks.toml's tests.json
                 allowlist gains ^\.dross/phases/06-remediate-security/tests\.json$.
                 .gitignore gains .dross/security/. The executor observes
                 `pnpm install --frozen-lockfile`, `pnpm build` and the full unit suite green
                 before committing.
                 Size exception (6 files): one layer (repo config), each edit is a line or two,
                 and every root-lockfile change must be in this one task.
       covers:   c-12, c-17
       contract: - gitleaks-config.spec 'every phase allowlisted' is red today (06 has a
                   spec.toml and no allowlist row). It goes green only with the exact anchored
                   06 path.
                 - if pnpm-lock.yaml resolves @sveltejs/kit < 3.1.1 or @sveltejs/adapter-node
                   < 6.0.1 under importers['.'] (semver on the resolved version, peer suffix
                   stripped), lockfile.spec 'kit and adapter-node at patched versions' fails
                 - if any packages/snapshots key still names @sveltejs/kit@3.1.0 or
                   @sveltejs/adapter-node@6.0.0 (a second copy pulled in by a peer),
                   lockfile.spec fails                                              [risk]
                 - if @electron/fuses is not an exact x.y.z devDependency, lockfile.spec fails
                 - if `git check-ignore -q .dross/security/x/report.md` exits non-zero (or, in
                   a git-less Stryker sandbox, .gitignore lacks a line exactly
                   `.dross/security/`), repo-hygiene.spec 'audit findings ignored' fails
                 - if `git ls-files` lists any path under .dross/security/, repo-hygiene.spec
                   fails
       depends:  —

Wave 2 (every task depends on t-1: until it lands the unit suite is red for an unrelated
reason, and every gate should run against patched Kit — see D1)

  t-2  Bind saved secrets to their destination                          [risk+verification+mvp]
       files:    src/lib/server/alerts/smtp.ts, src/lib/server/alerts/smtp.spec.ts,
                 src/lib/server/alerts/ntfy.ts, src/lib/server/alerts/ntfy.spec.ts,
                 src/lib/server/alerts/channels.spec.ts
       desc:     SMTP parse: a blank password reuses the saved one only when host
                 (case-insensitive), port and username (exact) all match. Otherwise it is
                 refused with a message naming the password, and nothing is saved (locked
                 secret_on_destination_change). ntfy parse: a blank token reuses the saved one
                 only on the same URL origin. A new clear_token field sets token null and keeps
                 the channel. clear_token together with a typed token is refused as
                 ambiguous (risk+verification; mvp let the typed token win). ntfy.spec:324
                 'write-only token' is inverted.
       covers:   c-1, c-2, c-20
       contract: - if smtpDriver.parseConfig with previous {host:'smtp.a.example', port:587,
                   username:'u'} and a blank password accepts host 'smtp.b.example', port 465
                   or username 'U' (each alone), smtp.spec 'destination change needs the
                   password' fails. The refusal must be {ok:false} with a message containing
                   'password' and no config.
                 - if host 'SMTP.A.EXAMPLE' (case only), port '587' or ' 587 ' with a blank
                   password is refused, smtp.spec 'no over-refusal' fails             [risk]
                 - if a blank re-save to the same destination, then a send to the in-repo test
                   SMTP server (src/lib/server/testing/smtp-server.ts), does not AUTH with the
                   original password, smtp.spec 'blank re-save still authenticates' fails
                   (c-20)
                 - if ntfyDriver.parseConfig keeps the saved token for a blank token when the
                   topic moves from https://ntfy.a.example/t to https://ntfy.sh/t, to
                   http://ntfy.a.example/t or to https://ntfy.a.example:8443/t, ntfy.spec 'new
                   origin needs the token' fails. A path-only move on the same origin, or an
                   explicit :443, must keep the token.
                 - if the ntfy fetch stub sees no `Authorization: Bearer <saved>` after a
                   blank same-origin re-save, ntfy.spec fails (c-20)          [verification]
                 - if a blank token on a new origin is refused when the saved token is null,
                   ntfy.spec fails (nothing to leak)
                 - if clear_token with a blank token does not give token null with the topic
                   kept, or clear_token plus a typed token returns ok, ntfy.spec fails
                 - if saveChannel after a refused destination change wrote anything (decrypted
                   config differs from before), channels.spec 'refused save writes nothing'
                   fails                                                       [verification]
                 - if any refusal message contains the saved or typed secret (sentinel
                   values), either driver spec fails
       depends:  t-1

  t-3  Claim Check-now cooldown atomically                              [verification+risk]
       files:    src/lib/server/checks.ts, src/lib/server/checks.spec.ts,
                 src/routes/watches/[id]/page.server.spec.ts
       desc:     checkNow claims the watch with one conditional UPDATE before calling check:
                 SET last_checked_at = now WHERE id = ? AND (last_checked_at IS NULL OR
                 <= now - cooldown) RETURNING id. No row back means cooldown, or not_found if
                 the watch is gone. recordCheck writes the same `now`. A throwing check keeps
                 the claim. (mvp used an in-memory Map instead — see D4.)
       covers:   c-4, c-21
       contract: - if 5 concurrent checkNow calls for one never-checked watch, with check()
                   held on a deferred promise, call check() more than once, or the other four
                   are not {kind:'cooldown'} with COOLDOWN_MESSAGE, checks.spec 'one fetch per
                   cooldown window' fails (real test DB from testing/test-db.ts, not a mock)
                 - if a failing check leaves lastCheckedAt at anything but the attempt time, a
                   checkNow at attempt+14:59.999 calls check, or one at attempt+15:00 does not,
                   checks.spec 'failure starts the cooldown' fails
                 - if a check() that throws leaves the watch claimable at once, checks.spec 'a
                   thrown check still holds the cooldown' fails
                 - if checkNow on an unknown id writes anything or returns other than
                   not_found, checks.spec fails                                       [risk]
                 - if dueWatches returns a watch while its Check-now fetch is in flight,
                   checks.spec fails                                                  [risk]
                 - if the route's ?/check action returns anything but the existing cooldown
                   failure for the second of two parallel POSTs, watches page.server.spec
                   fails                                                       [verification]
       depends:  t-1

  t-4  Enforce Origin and deny framing in the handle                    [verification+risk]
       files:    src/lib/server/local-request.ts, src/lib/server/local-request.spec.ts,
                 src/hooks.server.ts, e2e/node-server.ts, e2e/dev-guard.e2e.ts (new)
       desc:     createLocalRequestHandle returns a plain 403 for POST/PUT/PATCH/DELETE whose
                 Origin is missing or is not exactly http://<Host>, in every mode, with no
                 dev/building branch (see D6 on missing Origin). It sets X-Frame-Options: DENY
                 on every response it resolves. node-server.ts gains startDevServer (`vite
                 dev` on a free port, temp DB, the e2e key, SCHEDULER_DISABLED=1). The comment
                 in hooks.server.ts that says Kit's check covers dev is corrected.
                 Size exception (5 files, 2 layers): the hooks.server.ts edit is a comment
                 only, and dev-guard is the only real `vite dev` proof of c-5.
       covers:   c-5, c-6 (X-Frame-Options), c-19 (dev half, pre-CSP)
       contract: - if a POST to /?/add with Origin https://evil.example, 'null', http://
                   127.0.0.1:<other port> or none reaches resolve, local-request.spec 'foreign
                   Origin refused' fails, for form, multipart, text/plain and JSON bodies
                 - if a same-origin POST, or a GET with a foreign Origin, is refused,
                   local-request.spec fails (no over-refusal)
                 - if local-request.ts imports $app/environment or reads dev/building, the
                   source ?raw check in local-request.spec fails                      [risk]
                 - if a resolved 200, 404 or 500 response lacks X-Frame-Options: DENY,
                   local-request.spec 'every response denies framing' fails
                 - under a real `vite dev`: if any e2e/action-endpoints.ts ACTION_ENDPOINTS
                   entry answers a forged-Origin form POST with anything but 403, or the DB
                   snapshot changes, dev-guard.e2e fails (red today: Kit's check is compiled
                   out of dev)
                 - if GET / under `vite dev` in a Playwright browser is not 200 with the
                   watchlist rendered, or the page's own add-watch form (an unsupported .invalid
                   URL) gets 403 instead of the action's 400, dev-guard.e2e 'dev still works in
                   a browser' fails
       depends:  t-1

  t-5  Add strict CSP with frame-ancestors                              [verification+risk]
       files:    vite.config.ts, e2e/security-headers.e2e.ts (new)
       desc:     kit.csp, mode 'auto' (nonce on SSR, hash when prerendered): script-src 'self';
                 img-src 'self' https://m.media-amazon.com; frame-ancestors 'none'; object-src
                 'none'; base-uri 'self'; form-action 'self'. No default-src and no style-src,
                 because Svelte, Vite and app.html's inline style need inline styles (risk;
                 verification set default-src 'self' plus style-src 'unsafe-inline'). build.
                 assetsInlineLimit 0, so the 590-byte favicon is not a data: URI that img-src
                 blocks (risk). The executor checks that e2e seed image URLs are on
                 m.media-amazon.com or null.
       covers:   c-6 (frame-ancestors), c-23 (policy shape)
       contract: - on the preview build, if '/', '/account/alerts', a seeded '/watches/<id>' or
                   a 404 page lacks a CSP whose frame-ancestors is exactly 'none',
                   security-headers.e2e fails
                 - if script-src holds 'unsafe-inline', 'unsafe-eval', any scheme or host, any
                   token other than 'self' / 'nonce-…' / 'sha256-…', or no nonce/hash source,
                   security-headers.e2e fails
                 - if img-src is not exactly {'self', https://m.media-amazon.com},
                   security-headers.e2e fails
                 - if the built layout's rel=icon href starts with data:, security-headers.e2e
                   fails                                                              [risk]
       depends:  t-1

  t-6  Ignore wall phrases on product pages                             [verification+risk]
       files:    src/lib/server/shops/amazon/classify.ts,
                 src/lib/server/shops/amazon/classify.spec.ts
       desc:     A validateCaptcha form still marks a wall on any page. The BOT_WALL_TEXT
                 phrases count only on a page with no #productTitle, so review or bullet text
                 cannot force 'blocked'. isBotWall and classifyProductPage share the rule.
                 Fixture variants are built in memory, with no new committed fixture (r-02)
                 and no live fetch (r-01). (Risk used a wider marker set, #productTitle/#dp/
                 #ppd; 2 of 3 drafts chose #productTitle.)
       covers:   c-7
       contract: - for each BOT_WALL_TEXT phrase, injected into the first review of
                   recorded-plain.html and separately into its first #feature-bullets item: if
                   classifyProductPage gives anything but ok with the manifest's title and
                   pricePence, or isBotWall is true, classify.spec 'review/bullet phrase is not
                   a wall' fails (red today)
                 - if any FIXTURES entry whose expect.reason is 'blocked' (recorded-captcha-
                   continue, synthetic-captcha) stops classifying blocked, the fixtures.spec
                   corpus table fails
                 - if synthetic-captcha with its form removed and no #productTitle stops
                   classifying blocked, classify.spec 'phrase-only wall still blocked' fails
                 - if a product page with a form[action*=validateCaptcha] stops classifying
                   blocked, classify.spec fails                                       [risk]
       depends:  t-1

  t-7  Force https short links, linear nav normalise                    [verification]
       files:    src/lib/server/shops/amazon/url.ts, src/lib/server/shops/amazon/url.spec.ts,
                 src/lib/server/shops/amazon/short-link.spec.ts, src/lib/nav.ts,
                 src/lib/nav.spec.ts
       desc:     normaliseAmazonUrl returns short links with protocol https:. resolveShortLink
                 sends every hop through it (checked in short-link.ts), so one change covers
                 the first request and every Location hop. normalise() strips trailing
                 slashes with a backward character scan, no regex.
                 Size exception (5 files): two independent one-function fixes, each with its
                 spec. Split, each would be a task under 10 minutes.
       covers:   c-14, c-16
       contract: - if normaliseAmazonUrl('http://amzn.to/abc') is not {kind:'short',
                   url:'https://amzn.to/abc'}, url.spec fails; same for http://amzn.eu/d/xyz
                 - if a recording fake ShopClient sees any URL with protocol http: during
                   resolveShortLink('http://amzn.to/abc'), including a 302 hop whose Location
                   is http://amzn.eu/d/xyz, short-link.spec 'no plaintext request' fails
                 - if an http:// amazon.co.uk product URL stops normalising to its https
                   canonical, url.spec fails                                          [risk]
                 - if normalise('/a' + '/'.repeat(16384) + 'x'), or a pure 16k trailing-slash
                   run, takes 10 ms or more (best of 5, plain Node, vitest node project),
                   nav.spec 'linear on slash runs' fails
                 - if normalise differs from the old /\/+$/ replace on ['', '/', '//', '///',
                   '/a', '/a/', '/a//', '/account/alerts', '/account/alerts/',
                   '/account/alerts///', '/account//alerts/', '/a//b/', 'a/'] (table computed
                   from the old implementation, inline in the spec), nav.spec 'same output'
                   fails
       depends:  t-1

  t-8  Add per-launch session gate module                               [risk]
       files:    src/desktop/session-gate.ts (new), src/desktop/session-gate.spec.ts (new)
       desc:     Pure module with no electron import: createSessionSecret() (32 random bytes,
                 base64url), SESSION_COOKIE, cookieDetails(origin, secret) for
                 session.cookies.set, and isAuthorized({method, url, cookieHeader}, secret).
                 Exact GET /health (any query) is the only exemption. The secret is a
                 required parameter, so the gate fails closed. Not wired yet: t-16 wires it
                 in one commit, so no commit ships a server that 403s its own window (fixes
                 verification's t-8/t-16 split).
       covers:   c-3
       contract: - if isAuthorized is true without the cookie for any of: GET
                   /account/alerts/__data.json, POST /account/alerts?/save, GET
                   /_app/immutable/x.js, HEAD /health, POST /health, GET /health/, GET
                   /Health, GET /health/../account/alerts/__data.json, GET
                   /health/..%2faccount, GET //health, or absolute-form
                   'http://127.0.0.1:1/account', session-gate.spec 'only GET /health is
                   exempt' fails
                 - if GET /health and GET /health?x=1 are not authorised without a cookie,
                   session-gate.spec fails
                 - if a cookie header that is missing, empty, the wrong value, the right value
                   with one byte changed, a prefix of it, the value under another name, or
                   malformed ('pc=;;=', 300 KB of junk) authorises or throws,
                   session-gate.spec fails. The right cookie among other cookies must
                   authorise.
                 - if the comparison is not crypto.timingSafeEqual over equal-length buffers
                   (source ?raw: timingSafeEqual present, no ===/includes on the secret),
                   session-gate.spec fails
                 - if cookieDetails lacks httpOnly true, sameSite 'strict' or url equal to the
                   origin, or carries an expirationDate (a persisted cookie),
                   session-gate.spec fails
                 - if two createSessionSecret() calls are equal, or either decodes to fewer
                   than 32 bytes, session-gate.spec fails
       depends:  t-1

  t-9  Scrub alerts key from main's env                                 [risk]
       files:    src/desktop/server.ts, src/desktop/server.spec.ts,
                 e2e/desktop/harness.e2e.ts
       desc:     loadAdapterHandler deletes ALERTS_ENCRYPTION_KEY from process.env once the
                 handler module (and so Kit's init hook) has loaded, on success or throw.
                 harness.e2e 'launcher env' (line 111), which today asserts main holds the
                 key, is inverted. mvp and verification bundled this into the gate task, but
                 neither saw the harness.e2e flip.
       covers:   c-13
       contract: - if a fake handler module that records process.env at import time does not
                   see ALERTS_ENCRYPTION_KEY, or process.env still holds it after
                   loadAdapterHandler resolves, server.spec 'key gone after load' fails
                 - if a handler module whose import throws leaves the key in process.env,
                   server.spec fails
                 - if main's process.env (app.evaluate) holds ALERTS_ENCRYPTION_KEY after
                   launch, harness.e2e 'launcher env' fails
                 - if, in that launch, an SMTP channel saved through the window's own form
                   reads back as unreadable on reload instead of showing its host, harness.e2e
                   fails (the scrub ran before Kit's init took the key)
       depends:  t-1

  t-10 Wrap alerts key with safeStorage                                 [risk+verification+mvp]
       files:    src/desktop/alerts-key.ts, src/desktop/alerts-key.spec.ts,
                 src/desktop/main.ts, e2e/desktop/launch.ts
       desc:     loadOrCreateAlertsKey(keyFile, {safeStorage, platform}) takes a structural,
                 type-only SafeStorage. With a real backend (isEncryptionAvailable, and on
                 Linux a backend of gnome_libsecret or kwallet*), new keys are written wrapped:
                 a non-base64 prefix ('pcw1:') plus the base64 ciphertext, mode 0600. A raw
                 v0.1.5 file is migrated by temp-write, fsync, a decrypt round-trip check, then
                 rename. Any failure keeps the raw file and returns its key. A wrapped file
                 whose decrypt throws gives AlertsKeyError naming the path and is never
                 replaced. main.ts passes Electron's safeStorage in every launch (provisional,
                 see D8). launchDesktop adds --use-mock-keychain on darwin at the launch and
                 relaunch sites, not in electronArgs (harness.e2e pins that).
       covers:   c-24, c-25
       contract: - fresh load with a fake darwin backend: if the file parses as raw base64-32
                   or lacks the 'pcw1:' prefix, alerts-key.spec 'new key wrapped' fails
                 - if linux 'basic_text' or isEncryptionAvailable false wraps, or linux
                   'gnome_libsecret'/'kwallet5' keeps the file raw, alerts-key.spec fails.
                   basic_text must leave raw base64 at 0600 (POSIX).
                 - existing raw file plus a real backend: if it does not end wrapped, or the
                   returned key differs from the raw bytes, or a channel sealed under the raw
                   key fails to open with the returned key (crypto.ts openConfig),
                   alerts-key.spec 'migrates v0.1.5 raw key' fails
                 - for each failure point (encryptString throws, decryptString returns other
                   bytes, rename throws): if the raw file is not byte-identical afterwards, a
                   temp file remains, or the call does not return the raw key,
                   alerts-key.spec fails                                              [risk]
                 - if a wrapped file whose decrypt throws is rewritten, deleted or replaced by
                   a new key instead of throwing AlertsKeyError naming the path,
                   alerts-key.spec fails
                 - if any thrown or logged text contains the key's base64 or the ciphertext
                   (sentinel), alerts-key.spec fails
                 - if two concurrent loads over one raw file return different keys or leave
                   anything but one valid file, alerts-key.spec fails                 [risk]
                 - with no safeStorage passed: if behaviour differs from today's, the existing
                   alerts-key.spec rows fail                                   [verification]
       depends:  t-1

  t-11 Add env-gated file control channel                               [verification+risk]
       files:    src/desktop/e2e-control.ts (new), src/desktop/e2e-control.spec.ts (new),
                 src/desktop/boundary.spec.ts
       desc:     takeE2eControlDir(env) reads and deletes PRICE_CHECK_E2E_CONTROL_DIR
                 (absolute paths only). main hands it back to the installer on update, the
                 same way it does OUTPUT_CAPTURE_ENV. startE2eControl(dir, handlers) polls
                 <dir>/<pid>/ for req-<n>.json, runs one handler from a fixed set, and writes
                 res-<n>.json through temp + rename. The set: pid, info (version, isPackaged,
                 userData, platform, arch, origin, argv/execArgv), quit, loginItemOff,
                 updaterStatus/CheckNow/Restart, keyBackend, and appGet(path), where main
                 requests its own server with the cookie and returns status and body (risk).
                 Handlers are injected. Main wiring happens in t-22. No eval, no listener.
                 (mvp used stdin JSON lines instead — see D7.)
       covers:   c-27
       contract: - if takeE2eControlDir returns non-null for an unset, empty or relative
                   value, or leaves the variable in env, e2e-control.spec fails
                 - if startE2eControl is reached with the variable unset (a fake fs and fake
                   timers record any call or timer), e2e-control.spec 'inactive unless set'
                   fails
                 - if an unknown command, {cmd:'eval'}, or a known command with extra fields
                   does anything but write {ok:false, error:'unknown command'} with no handler
                   called, e2e-control.spec fails
                 - if net.Server.prototype.listen, dgram.createSocket or http.createServer is
                   called during a session (spied), e2e-control.spec 'no network listener'
                   fails
                 - if e2e-control.ts imports node:net, node:http(s), node:dgram, node:tls,
                   node:inspector, node:vm, node:child_process or electron, or contains
                   eval( / new Function / a dynamic import, boundary.spec fails
                 - if any response, for every command, contains the session secret (a sentinel
                   injected through the appGet dependency), e2e-control.spec fails     [risk]
                 - if a request under another pid's directory is answered, or stop() leaves a
                   timer running, e2e-control.spec fails                              [risk]
                 - with a real temp dir: if a pid request gives no res file holding the
                   handler's pid within 2 s, e2e-control.spec fails
       depends:  t-1

  t-12 Verify fuse wire and signed entitlements                         [verification+risk]
       files:    scripts/verify-packaged.ts, scripts/verify-packaged.spec.ts
       desc:     A new `fuses <exe>` mode reads the wire with @electron/fuses (provisional,
                 see D3). It requires RunAsNode, EnableNodeOptionsEnvironmentVariable,
                 EnableNodeCliInspectArguments and GrantFileProtocolExtraPrivileges off, and
                 EnableEmbeddedAsarIntegrityValidation and OnlyLoadAppFromAsar on, in every
                 slice of a universal binary. On darwin the wire is read from
                 Contents/Frameworks/Electron Framework.framework, not the launcher. `mac
                 --signed` also reads `codesign -d --entitlements - --xml` and refuses
                 com.apple.security.cs.disable-library-validation.
       covers:   c-8
       contract: - with an injected wire reader: for each of the six fuses flipped the wrong
                   way, if verifyFuses returns no violation naming that fuse,
                   verify-packaged.spec fails. A wire missing a fuse is a violation.
                 - if the all-correct wire gives any violation, verify-packaged.spec fails
                 - if a binary with no sentinel, a truncated wire or an unknown version
                   passes, or two slices that disagree pass, verify-packaged.spec fails
                   (fail closed, never "all off")                                     [risk]
                 - if reading the stock node_modules/electron binary (control, skipped when
                   absent) does not report RunAsNode and EnableNodeCliInspectArguments ON,
                   verify-packaged.spec fails (proves the reader sees real wires)     [risk]
                 - if the darwin fuse path does not point into Contents/Frameworks/Electron
                   Framework.framework, verify-packaged.spec fails                    [risk]
                 - fake runner: if verifyMac --signed passes entitlements XML that contains
                   disable-library-validation, or rejects one with only allow-jit,
                   verify-packaged.spec fails. The unsigned path must not run the
                   entitlements command.
                 - if runCli or the usage string does not route `fuses`,
                   verify-packaged.spec fails
       depends:  t-1

  t-13 Add pinned signing toolchain and signer                          [verification+risk]
       files:    signing/package.json (new), signing/pnpm-lock.yaml (new),
                 scripts/sign-mac.ts (new), scripts/sign-mac.spec.ts (new)
       desc:     signing/ holds only electron-builder, pinned to the root devDependency's exact
                 version, with no scripts and its own frozen lockfile. It is installed with
                 `pnpm install --dir signing --ignore-workspace --frozen-lockfile
                 --ignore-scripts`. sign-mac.ts --version <v> --app <path.app> loads
                 electron-builder through createRequire from signing/. It refuses missing
                 signing variables (reusing missingSigningVariables) and builds dmg, zip and
                 latest-mac.yml from the prepackaged app with builderConfig({version,
                 sign:true}). package-desktop.ts is not edited, so the sign config cannot
                 drift from the build config. (mvp handed a JSON sign-config between jobs
                 instead — see D9.) The executor observes an unsigned local prepackaged run
                 produce the release file set before committing (risk).
       covers:   c-26
       contract: - if signing/package.json has any dependency besides electron-builder,
                   scripts or a postinstall, or its electron-builder differs from root
                   package.json's exact version, or signing/pnpm-lock.yaml importers list
                   anything else, sign-mac.spec 'signing toolchain' fails
                 - if sign-mac.ts, or anything it imports transitively (package-desktop.ts,
                   src/desktop/app-id.ts), has a runtime import other than node:*, relative
                   files or `import type` (no $app/*, #lib/*), sign-mac.spec 'runs without the
                   project install' fails
                 - with an injected resolver and build: if the builder is resolved from
                   anywhere but signing/, the call lacks `prepackaged: <app>`, or its config
                   differs from builderConfig({version, sign:true}), sign-mac.spec fails
                 - if any of the five signing variables is missing and the run does not exit
                   non-zero naming only the missing names, or --app is not an existing .app dir
                   and the build still runs, sign-mac.spec fails
       depends:  t-1

  t-14 Check live repo security settings                                [verification+risk]
       files:    scripts/repo-settings.ts (new), scripts/repo-settings.spec.ts (new),
                 .github/workflows/repo-settings.yml (new)
       desc:     A pure evaluate(snapshot) plus a fetcher with injected fetch, using Node
                 built-ins only. It requires: an active tag ruleset on refs/tags/v* with
                 creation, update and deletion rules (risk adds non_fast_forward) whose only
                 bypass is RepositoryRole 5; the release environment matching
                 .github/environments/release.json (only a tag-type v* policy,
                 protected_branches false, no required reviewer, per locked
                 release_env_reviewer); immutable releases on; vulnerability alerts on. A
                 missing token, a non-2xx response or a network error is a violation. The
                 workflow triggers on push to main, a schedule and workflow_dispatch; it has
                 contents: read, SHA-pinned actions, no install, and GH_TOKEN from
                 secrets.REPO_SETTINGS_TOKEN. It is not a required check. BLOCKER for the live
                 run: Michal creates the token.
       covers:   c-9, c-10, c-11 (Dependabot alerts verified)
       contract: - for each fixture snapshot (no tag ruleset; enforcement 'evaluate'; include
                   refs/tags/* without v*; creation rule missing; a bypass actor other than
                   admin or an extra one; environment with a branch-type v* policy,
                   protected_branches true or custom_branch_policies false; immutable releases
                   {enabled:false}; vulnerability-alerts 404), if evaluate returns no violation
                   naming it, repo-settings.spec fails
                 - if the all-good snapshot returns any violation, repo-settings.spec fails
                 - if the CLI exits 0 with GH_TOKEN unset, on a 401/403/404/5xx from any
                   endpoint, or on a network error, repo-settings.spec 'fails closed' fails
                 - if any output line contains the token value (sentinel),
                   repo-settings.spec fails                                           [risk]
                 - if repo-settings.yml lacks the push-main or schedule trigger, runs an
                   install, uses a non-SHA action, has permissions beyond contents: read, or
                   exposes the token to any step but the check, repo-settings.spec fails.
                   `pnpm ci:policy` must stay 0.
       depends:  t-1

Wave 3
  t-15 Show clear-token control and inline refusal                      [risk+verification+mvp]
       files:    src/routes/account/alerts/+page.svelte,
                 src/routes/account/alerts/page.svelte.spec.ts,
                 src/routes/account/alerts/page.server.spec.ts,
                 src/routes/account/alerts/alerts.e2e.ts
       desc:     The ntfy card shows a "Remove access token" checkbox (name clear_token) only
                 while tokenSet. A refused destination change from t-2 shows inline in that
                 channel's card through the existing fail(400, {kind, message}). The saved
                 channel is unchanged.
       covers:   c-1, c-2
       contract: - if the ntfy card renders a clear_token control while tokenSet is false, or
                   none while it is true, page.svelte.spec fails
                 - if ?/save with clear_token on a saved ntfy channel does not leave the
                   channel present, enabled as before, with tokenSet false,
                   page.server.spec 'clear token keeps channel' fails
                 - if ?/save that changes the SMTP host, or moves the ntfy topic to another
                   origin, with a blank secret returns anything but fail(400) with that card's
                   kind and a message naming the secret, or the stored config_enc blob
                   changes, page.server.spec fails
                 - in the browser: if that refused save shows no message inside its card, or a
                   reload shows the new host/topic, alerts.e2e fails
                 - if saving with clear_token ticked does not flip the card to 'Access token:
                   none.' with the ntfy card still listed, alerts.e2e 'clear token keeps
                   channel' fails                                                      [mvp]
       depends:  t-2

  t-16 Wire session cookie into window and server                       [risk (+verification contracts)]
       files:    src/desktop/server.ts, src/desktop/server.spec.ts, src/desktop/window.ts,
                 src/desktop/window.spec.ts, src/desktop/main.ts, e2e/desktop/guard.e2e.ts
       desc:     main creates the secret once per launch and passes it in memory, never in
                 env or argv. startDesktopServer({handler, secret}) answers 403 'Forbidden'
                 after the Host check, before adapter-node/sirv, when isAuthorized is false.
                 createMainWindow and the showWindow reopen paths await
                 session.cookies.set(cookieDetails) before any loadURL. guard.e2e's raw-request
                 rows are rewritten for the gate, including the immutable-asset 'served' row
                 at ~line 199.
                 Size exception (6 files, 2 layers): split, a commit would serve a server that
                 403s its own window (see D5).
                 Known red window: smoke.packaged 'x64 slice' and update.packaged's relaunch
                 make cookieless raw requests, so the packaged suite is red from this task
                 until t-22. No task in wave 3 may cite the packaged suite.
       covers:   c-3
       contract: - if startDesktopServer answers a request without the cookie with anything but
                   403 'Forbidden' (the same body as the Host 403, so no oracle), or calls the
                   handler or sirv for it, or gives GET /health without the cookie anything but
                   the handler's response, server.spec fails
                 - if startDesktopServer accepts a missing or empty secret, server.spec fails
                   (fail closed)
                 - if createMainWindow calls loadURL before the cookies.set promise resolves,
                   on first open or on reopen after close, or a rejected cookies.set leads to
                   loadURL, window.spec fails (call-order log)
                 - if main.ts puts the secret in process.env or any argv, the source ?raw
                   check in window.spec fails
                 - desktop e2e, raw node:http with no cookie: if GET /, GET
                   /account/alerts/__data.json, an immutable asset, or any ACTION_ENDPOINTS
                   POST (with matching Host and Origin) is not 403, or its body contains the
                   seeded topic, or the DB snapshot changes, guard.e2e 'no secret, no access'
                   fails. GET /health must stay 200.
                 - if the same raw GET / with the window's own cookie (read via
                   session.cookies.get in app.evaluate) is not 200, guard.e2e fails (the
                   cookie, not something else, is the gate)                    [verification]
                 - if the window's own ?/save and ?/add form posts stop reaching their actions,
                   guard.e2e "the window's own form posts reach their actions" fails. Any
                   desktop e2e page load that gets 403 fails its test.
       depends:  t-8

  t-17 Prove key migration on the real backend                          [risk]
       files:    e2e/desktop/first-run.e2e.ts, e2e/desktop/seed-child.ts
       desc:     seed-child gains a command that writes a v0.1.5-style raw alerts.key and an
                 SMTP channel sealed under it. The e2e launches over that userData and checks
                 the file form against the backend the app reports: the macOS mock keychain,
                 Windows DPAPI, and basic_text on Linux CI. The desktop e2e runs on all three
                 OSes in CI.
       covers:   c-24, c-25
       contract: - where safeStorage reports a real backend: if alerts.key after the first
                   launch is still raw base64, first-run.e2e 'v0.1.5 key migrates' fails. On
                   Linux basic_text, if the file is not byte-identical to the seed, it fails.
                 - if the seeded SMTP channel shows as unreadable, or its Send test does not
                   authenticate at the local test SMTP server with the seeded password,
                   first-run.e2e fails (c-25 "still sends")
                 - if a second launch on the migrated file does not open the same channel,
                   first-run.e2e fails
       depends:  t-10

  t-18 Record CSP violations, prove dev under CSP                       [risk+verification]
       files:    e2e/desktop/launch.ts, e2e/desktop/csp.e2e.ts (new), e2e/dev-guard.e2e.ts
       desc:     launchDesktop installs a securitypolicyviolation listener plus a console
                 'Content Security Policy' / 'Refused to' matcher on every window from the
                 first page on. dispose/close throws when any violation was seen, so every
                 desktop test gates on zero. dev-guard.e2e also loads / and /account/alerts
                 under `vite dev` with the CSP in place and saves a form.
       covers:   c-23 (zero violations), c-19 (dev under CSP)
       contract: - if csp.e2e, which injects an inline <script> and an <img> on an .invalid host
                   into the live window, records anything but exactly two violations, it
                   fails (proves the collector listens)                        [verification]
                 - if any desktop e2e page logs a CSP violation (a blocked chart style, a seed
                   image off the CDN, Kit's bootstrap, the favicon), that test's dispose
                   fails, naming the directive and blocked URI
                 - under `vite dev`: if GET / or /account/alerts is not 200 and hydrated (a
                   client-only element appears), logs a CSP violation, or a same-origin form
                   save fails, dev-guard.e2e fails                                    [risk]
       depends:  t-5, t-4

  t-19 Split release signing job, clean the p8                          [verification+risk+mvp]
       files:    .github/workflows/release.yml, scripts/release-workflow.spec.ts,
                 scripts/workflow-policy.ts, scripts/workflow-policy.spec.ts
       desc:     build-macos packages the unsigned, fused .app with no environment and no
                 secrets, and uploads it as a tar (upload-artifact drops framework symlinks and
                 exec bits). sign-macos (environment release, the five secrets) checks out the
                 tag, installs only signing/ and runs scripts/sign-mac.ts. Its step sets `trap
                 'rm -f "$RUNNER_TEMP/AuthKey.p8"' EXIT` before decoding the key. verify-macos
                 has no secrets and no environment; it runs verify-packaged layout, mac --signed
                 and fuses, plus the packaged smoke, on the signed artefact. build-windows and
                 build-linux gain a `verify-packaged.ts fuses` step before upload (mvp).
                 publish needs verify-macos, build-windows and build-linux. workflow-policy.ts
                 (pnpm ci:policy, part of the required static check) gains a fail-closed
                 allowlist for secret-bearing jobs and the p8-trap rule (locked
                 signing_job_split).
       covers:   c-15, c-26, c-8 (release fuses check)
       contract: - fixture workflows: if a job that references CSC_LINK, CSC_KEY_PASSWORD,
                   APPLE_API_KEY_P8_BASE64, APPLE_API_KEY_ID or APPLE_API_ISSUER contains a
                   root `pnpm install` (anything but --dir signing with --frozen-lockfile and
                   --ignore-scripts), pnpm build, build:desktop, package:desktop, test,
                   test:e2e*, npx, npm, or `node scripts/<anything but sign-mac.ts>`, and
                   checkWorkflow reports nothing, workflow-policy.spec 'signing job isolation'
                   fails
                 - if a step that writes AuthKey.p8 has no `trap … rm -f
                   "$RUNNER_TEMP/AuthKey.p8"' EXIT`, or the trap comes after the write, and no
                   violation is reported, workflow-policy.spec 'p8 cleanup' fails
                 - if `pnpm ci:policy` on the shipped tree exits non-zero, workflow-policy.spec
                   'shipped workflows clean' fails
                 - if any job but sign-macos takes environment: release or references a release
                   secret, sign-macos does not need build-macos, or verify-macos holds a secret
                   or environment, release-workflow.spec fails
                 - if build-macos uploads the .app other than as a tar, or sign-macos does not
                   download it, release-workflow.spec fails                           [risk]
                 - if publish does not need verify-macos, build-windows and build-linux,
                   release-workflow.spec fails (an unverified signed build never ships)
                 - if the macOS, Windows or Linux path lacks a `verify-packaged.ts fuses` step
                   before its upload, release-workflow.spec fails                      [mvp]
       depends:  t-13, t-12

  t-20 Apply tag ruleset, immutability, Dependabot                      [verification+risk]
       files:    .github/rulesets/release-tags.json (new), scripts/rulesets.spec.ts
       desc:     The committed tag ruleset (target tag, include refs/tags/v*, rules creation,
                 update, deletion and non_fast_forward, bypass only RepositoryRole 5) is
                 applied with `gh api`, along with PUT immutable-releases and PUT
                 vulnerability-alerts. No reviewer is added to release (locked
                 release_env_reviewer). No secret is read or printed.
       covers:   c-9, c-10, c-11
       contract: - if release-tags.json is not target 'tag', enforcement 'active', include
                   exactly ['refs/tags/v*'], or lacks creation, update or deletion,
                   rulesets.spec 'tag ruleset' fails
                 - if bypass_actors is anything but exactly one {actor_type:'RepositoryRole',
                   actor_id:5}, rulesets.spec fails
                 - if the branch-ruleset check-name comparison starts reading release-tags.json
                   (tag rulesets need no CI checks), rulesets.spec fails             [risk]
                 - live, in the task log: `node scripts/repo-settings.ts` is observed exiting 1
                   before the apply (naming the missing ruleset, immutability and alerts) and
                   0 after, and a workflow_dispatch run of repo-settings.yml is observed green
                                                                               [verification]
       depends:  t-14

  t-21 Audit shipped dependency trees                                   [verification+risk]
       files:    scripts/audit-shipped.ts (new), scripts/audit-shipped.spec.ts (new),
                 .github/workflows/audit.yml
       desc:     audit.yml drops `--prod`, feeds `pnpm audit --json` over the full tree and
                 over signing/'s lockfile (risk) to audit-shipped.ts, and runs no install with
                 scripts. The script fails on a high or critical advisory whose path root is a
                 production dependency, one of SHIPPED_DEV (electron, @sveltejs/kit, svelte,
                 @sveltejs/adapter-node), or anywhere in the signing tree. Dev-only advisories
                 are reported, not fatal. It fails closed on output it cannot parse. Fixtures
                 are cut from real `pnpm audit --json` output. (mvp dropped --prod with a GHSA
                 ignore list and no script — see D10.)
       covers:   c-11
       contract: - if a fixture with a high advisory on '.>@sveltejs/kit>devalue', on
                   '.>electron>…', on '.>nodemailer', or on a transitive dependency reached only
                   through svelte exits 0, audit-shipped.spec fails
                 - if a fixture whose only high advisory sits on '.>drizzle-kit>esbuild' or
                   vitest exits non-zero, or a moderate advisory on kit exits non-zero,
                   audit-shipped.spec fails
                 - if non-JSON, empty or truncated stdout, or a JSON error object, exits 0,
                   audit-shipped.spec fails (fail closed)
                 - if a SHIPPED_DEV name is not a devDependency in package.json, or audit.yml
                   still passes --prod, does not audit signing/, or does not run
                   audit-shipped.ts, audit-shipped.spec fails
                 - in the task log, the executor observes `node scripts/audit-shipped.ts` exit
                   0 on the t-1-bumped tree                                           [risk]
       depends:  t-13

Wave 4
  t-22 Drive the packaged app without the inspector                     [verification+risk+mvp]
       files:    src/desktop/main.ts, e2e/packaged/launch-packaged.ts,
                 e2e/packaged/smoke.packaged.ts, e2e/packaged/update.packaged.ts
       desc:     main.ts calls takeE2eControlDir before the env swap and wires the t-11
                 handlers. appGet uses the t-16 secret, so the secret never leaves main. The
                 control dir is handed to the installer on update. launchPackaged spawns the
                 exe itself with --remote-debugging-port=0 (plus --use-mock-keychain on
                 darwin), reads DevToolsActivePort from userData and connects
                 chromium.connectOverCDP to the window. Every app.evaluate becomes a control
                 command or a renderer evaluate. _electron is no longer imported. The
                 cookieless rawRequests in 'x64 slice' and the update relaunch become appGet
                 calls, plus explicit 403 assertions. Proven on default fuses, so a red run
                 points at the harness only.
       covers:   c-22, c-27, c-3 (packaged), c-24/c-25 (packaged)
       contract: - if launch-packaged.ts imports _electron, or the args it spawns match
                   /^--inspect/, smoke.packaged 'no inspector' fails
                 - if the app's argv/execArgv from the control 'info' command contains
                   --inspect or --inspect-brk, smoke.packaged fails
                 - if main.ts does not wire the control channel, every packaged test fails at
                   launch (no pid reply within the timeout), so the suite cannot pass
                   vacuously
                 - if a cookieless GET / or /account/alerts/__data.json to the packaged server
                   is not 403, or appGet('/') is not 200 with the seeded watch title,
                   smoke.packaged fails, x64 slice on darwin included                 [risk]
                 - on Linux: if the app's processes listen on any TCP port besides the server
                   port and the DevToolsActivePort port, smoke.packaged fails (the control
                   channel opened a listener; c-27)                                   [risk]
                 - if the relaunched updated version does not answer the control channel (the
                   variable was lost at hand-over), or its appGet('/') lacks the watch title,
                   update.packaged fails                                              [risk]
                 - darwin/win32: if alerts.key after the first packaged launch parses as raw
                   or lacks 'pcw1:', smoke.packaged 'key wrapped' fails. Linux basic_text must
                   stay raw at 0600.                                  [verification t-21 graft]
                 - pnpm test:e2e:packaged is observed green locally on macOS before commit,
                   on default fuses
       depends:  t-11, t-16, t-10

Wave 5
  t-23 Flip fuses, ship tightened entitlements                          [verification+risk+mvp]
       files:    scripts/package-desktop.ts, scripts/package-desktop.spec.ts,
                 build-resources/entitlements.mac.plist (new), e2e/packaged/smoke.packaged.ts
       desc:     builderConfig sets electronFuses: runAsNode,
                 enableNodeOptionsEnvironmentVariable, enableNodeCliInspectArguments and
                 grantFileProtocolExtraPrivileges false; enableEmbeddedAsarIntegrityValidation
                 and onlyLoadAppFromAsar true; resetAdHocDarwinSignature true, so unsigned
                 arm64 builds still launch (risk). mac.entitlements and entitlementsInherit
                 point at the new plist, which has allow-jit only. The smoke gains a
                 run-time inspector refusal (risk).
       covers:   c-8, c-22
       contract: - if builderConfig({sign}), for sign true or false, has any of the four "off"
                   fuses not exactly false or either "on" fuse not exactly true,
                   package-desktop.spec 'fuses' fails
                 - if mac.entitlements or entitlementsInherit is unset (which falls back to the
                   default plist that carries disable-library-validation) or is not the
                   build-resources plist, package-desktop.spec fails
                 - if the plist contains disable-library-validation,
                   allow-dyld-environment-variables or allow-unsigned-executable-memory, or
                   lacks allow-jit, package-desktop.spec fails
                 - if the files patterns admit build-resources/entitlements.mac.plist or
                   signing/x into the app, package-desktop.spec's files table fails    [risk]
                 - if the packaged app launched with --inspect=0 prints 'Debugger listening'
                   or opens an inspector listener, smoke.packaged fails (the fuse holds at
                   run time)                                                          [risk]
                 - a local `pnpm package:desktop`, then `verify-packaged.ts fuses <exe>`, is
                   observed exiting 0, and pnpm test:e2e:packaged is observed green on that
                   fused build, before commit
       depends:  t-22, t-12

Wave 6
  t-24 Check fuses in CI on three OSes                                  [verification]
       files:    .github/workflows/ci.yml, scripts/ci-packaged.spec.ts
       desc:     A `node scripts/verify-packaged.ts fuses "$PRICE_CHECK_PACKAGED_EXE"` step
                 goes after the packaged job locates the exe, before the packaged smoke.
                 ci-packaged.spec also gets the static no-inspector guard for e2e/packaged
                 (risk). This task cannot land before t-23, because the step fails on default
                 fuses. It is kept separate from t-23 because merging would make a 6-file,
                 two-layer task. It owns the observed 3-OS run.
       covers:   c-8, c-22
       contract: - if ci.yml's packaged job lacks the fuses step before the packaged smoke,
                   ci-packaged.spec fails
                 - if any file in e2e/packaged imports _electron, or any launch or spawn args
                   there contain --inspect or --inspect-brk, ci-packaged.spec fails  [risk]
                 - the PR's CI is observed green on linux, macos and windows with fuses on:
                   the packaged e2e passes without the inspector (c-22), and the fuses step
                   passes on each OS. Windows and Linux green is read from CI, never claimed
                   earlier.
       depends:  t-23

Wave 7
  t-25 Re-audit and close SEC-01..17                                    [risk+verification+mvp]
       files:    .dross/security/state.toml (gitignored, never committed)
       desc:     On the branch head, run pnpm test:unit --run, pnpm lint, pnpm check, pnpm
                 test:e2e (preview plus dev-guard), pnpm test:e2e:desktop, the PR CI packaged
                 e2e on 3 OSes, and `pnpm dev` opened in a browser. Then run a fresh
                 /dross-secure. Mark each SEC id resolved or dismissed: SEC-12 per locked
                 sec12_output_capture_seam, and SEC-14's queue cap per sec14_queue_cap. If
                 /dross-secure raises the honoured renderer CDP switch, the control channel or
                 the signing split, record it explicitly (risk). A new medium-or-higher
                 finding is a blocker, not a note.
       covers:   c-18, c-19
       contract: - if the fresh run's reconcile reports any new or regressed finding at medium
                   or higher, the task fails and opens a remediation task
                 - if any of SEC-01..SEC-17 is missing from state.toml, or has a status other
                   than resolved or dismissed, the task fails
                 - if `git ls-files .dross/security` prints anything, the task fails
                 - c-19: if dev-guard.e2e 'dev still works in a browser' or the packaged e2e
                   is red with the session gate and fuses both in place, c-19 fails. Each
                   command's output is read before anything is reported green.
       depends:  t-1 … t-24
```

## Coverage

| Criterion | Tasks |
|---|---|
| c-1 | t-2, t-15 |
| c-2 | t-2, t-15 |
| c-3 | t-8, t-16, t-22 |
| c-4 | t-3 |
| c-5 | t-4 |
| c-6 | t-4 (X-Frame-Options), t-5 (frame-ancestors) |
| c-7 | t-6 |
| c-8 | t-12, t-19, t-23, t-24 |
| c-9 | t-14, t-20 |
| c-10 | t-14, t-20 |
| c-11 | t-14, t-20 (Dependabot alerts on and checked), t-21 (shipped-tree audit) |
| c-12 | t-1 |
| c-13 | t-9 |
| c-14 | t-7 |
| c-15 | t-19 |
| c-16 | t-7 |
| c-17 | t-1 |
| c-18 | t-25 |
| c-19 | t-4 (dev, pre-CSP), t-18 (dev under CSP), t-22/t-23 (packaged with gate, then fuses), t-25 (final) |
| c-20 | t-2 |
| c-21 | t-3 |
| c-22 | t-22, t-23, t-24 |
| c-23 | t-5 (policy shape), t-18 (zero violations, collector proven live) |
| c-24 | t-10, t-17, t-22 |
| c-25 | t-10, t-17, t-22 |
| c-26 | t-13, t-19 |
| c-27 | t-11, t-22 |

27/27 covered.

## Disagreements

**D1. Wave 1: t-1 alone, or a wide parallel wave 1**
- verification puts t-1 alone, and every other task depends on it. Its reason: gitleaks-config.spec is red today (confirmed), so no other task's unit gate can go green before t-1, and gates should run against patched Kit.
- risk and mvp start about 10–13 tasks in wave 1 and don't see the red spec.
- Provisional default: t-1 alone.
- Why it matters: with a wide wave 1, every wave-1 task's commit gate is red for an unrelated reason. That is the false-green pattern in CLAUDE.md's Execution rules. The cost is one wave of latency.

**D2. When the fuses flip, relative to the harness rework**
- risk flips fuses in wave 1 and accepts that the packaged e2e is knowingly red for 3 waves, until the harness drops --inspect. Its reason: the signing path needs the fuse config.
- mvp and verification flip fuses only after the harness runs without the inspector on default fuses, so a red packaged run points at one change.
- Provisional default: harness first (t-22), then fuses (t-23). The signing path doesn't need the flip first, because sign-mac.ts reads builderConfig at run time.
- Why it matters: the longer the packaged suite is knowingly red, the more tasks commit without one of their real gates. Under the default, the red window is t-16 → t-22, one wave, caused by the cookieless raw requests. No draft named that window.

**D3. How the fuse wire is read**
- risk writes an in-repo parser (Node built-ins only) to avoid a new direct dependency.
- mvp and verification import @electron/fuses as an exact devDependency. It is already at 1.8.0 in the lockfile through electron-builder.
- Provisional default: @electron/fuses, plus risk's controls grafted into t-12: a stock-Electron-binary read showing ON, fail-closed on no sentinel, and every universal slice checked.
- Why it matters: the in-repo parser is a whole extra task with its own false-green risk. The library adds no new package to the tree. If @electron/fuses reads only the first slice of a universal binary, t-12 must handle that, or Michal may prefer risk's parser.

**D4. Check-now claim: conditional UPDATE or in-memory Map**
- risk and verification use a conditional UPDATE on last_checked_at. It survives a restart, holds the cooldown on a thrown check, and keeps the scheduler off an in-flight watch.
- mvp uses an in-memory Map. Its objection: the UPDATE makes "last checked" show before any result exists, and it changes what dueWatches treats as due.
- Provisional default: the conditional UPDATE.
- Why it matters: it changes user-visible "last checked" timing during an in-flight check. It also changes whether a crash mid-check leaves a cooldown behind.

**D5. Where the window's session cookie is set, and the half-gated commit**
- risk and verification set it in window.ts (createMainWindow plus the reopen paths).
- mvp sets it once on session.defaultSession in main's startServer, before any window, and doesn't touch window.ts.
- verification also splits the server gate (W2) from the cookie (W3), so the commit between them 403s the app's own window. risk keeps both in one 6-file task.
- Provisional default: risk's one-task wiring (t-16) with window.ts.
- Why it matters: mvp's placement would cut t-16 to 4 files and remove its size exception. It is safe only if no window ever uses a non-default session or partition. Verification's split must not be adopted under any default.

**D6. Missing Origin on an unsafe method**
- risk lets a POST with no Origin through c-5's check. Its reasoning: browsers always send Origin, raw local clients are c-3's job, and it avoids over-refusal.
- mvp and verification refuse it in every mode, which matches Kit's production CSRF check and the existing guard.e2e row "a … missing Origin gets 403".
- Provisional default: refuse.
- Why it matters: under `pnpm dev` there is no c-3 gate, so allowing a missing Origin leaves any local non-browser client free to post actions in dev. Refusing may break dev tooling that posts without an Origin.

**D7. Main-process control channel transport**
- risk and verification use a file mailbox polled by main.
- mvp uses stdin/stdout JSON lines, and rejects the mailbox as "slower and racier".
- verification rejects stdio: stdin is lost when the updater relaunches the app, and Windows GUI-subsystem stdio is unreliable.
- Provisional default: the file mailbox.
- Why it matters: update.packaged must reach the relaunched version, and only the mailbox survives that hand-over. Stdio would leave the update flow untestable without --inspect.

**D8. safeStorage in every Electron launch, or packaged builds only**
- risk and mvp wrap whenever safeStorage has a real backend. Desktop e2e uses --use-mock-keychain, and risk's t-17 proves migration plus a real Send test in desktop e2e on all three CI OSes.
- verification wraps only when app.isPackaged. Otherwise unpackaged runs, such as `pnpm dev:desktop`, write an "Electron Safe Storage" entry to the developer's real keychain or prompt for it. It proves c-24/c-25 in the packaged smoke instead.
- Provisional default: every launch. t-17 stays, and verification's packaged assertion is grafted into t-22.
- Why it matters: this decides whether Michal's own keychain gets an entry, or a prompt, the first time he runs dev:desktop. If he picks packaged-only, drop t-17 and keep only t-22's packaged assertion. c-25's "still sends" then rests on unit tests plus a decrypted card, because verification rejected a live send from the packaged app.

**D9. How the signing job gets its config**
- mvp has the secret-free job emit `builderConfig({sign:true})` as JSON (`--sign-config`) and run the stock electron-builder CLI with it, so no project code runs next to the secrets.
- verification and risk run a small checked-out sign-mac.ts that rebuilds the config from builderConfig at the tag, with a source check that its transitive imports are node:*, relative or type-only.
- verification rejects the JSON hand-off: a config from an earlier job could inject afterSign hooks into the secret-holding job.
- Provisional default: sign-mac.ts.
- Why it matters: the choice is about which input to the secret job is trusted. mvp's way runs project code there; the default instead takes no artifact-borne config into the job that holds the Developer ID cert.

**D10. How c-11's audit scopes to shipped dependencies**
- risk and verification add a filter script over `pnpm audit --json`: high or critical on prod roots, SHIPPED_DEV and the signing tree is fatal, and dev-only advisories are reported.
- mvp drops `--prod` and lists build-only GHSAs in pnpm-workspace.yaml auditConfig.
- Provisional default: the filter script (t-21).
- Why it matters: mvp's way has less code, but any new high advisory in a build-only tool (esbuild, vitest) turns the audit red until someone adds an ignore. The script costs a task and a fail-closed parser.

**D11. Apply the repo settings first, or build the check first**
- risk applies the tag ruleset, immutable releases and Dependabot in wave 1 with no token, then builds the check in wave 2.
- verification builds the check first (t-14), then applies (t-20), observing it exit 1 before and 0 after.
- Provisional default: check first.
- Why it matters: only check-first gives a red-to-green proof that the check sees the settings. It also puts the REPO_SETTINGS_TOKEN blocker in wave 3, on t-20's workflow_dispatch observation, instead of after the settings are already live.

The majority picked these lower-stakes points, and Michal can flip any of them in a line:
- clear_token plus a typed token is refused (mvp: the typed token wins).
- img-src is exactly m.media-amazon.com (mvp also allowed images-na/images-eu.ssl-images-amazon.com; only m.media-amazon.com appears in fixtures and seeds).
- No default-src or style-src (verification: default-src 'self' plus style-src 'unsafe-inline').
- The wall-phrase marker is #productTitle only (risk: #productTitle/#dp/#ppd).
- The live check runs as its own workflow (mvp: a job in audit.yml).

## Human blockers

- **You (Michal): create the REPO_SETTINGS_TOKEN repo secret.** It must be a fine-grained token on this repo only, with Administration: read and Metadata: read. GITHUB_TOKEN can't read the immutable-releases or vulnerability-alerts endpoints. t-14 can merge without it, but t-20's live red-to-green observation and every scheduled run of repo-settings.yml need it. I (Claude) stop and ask at that step and never read or print the value.
- **You (Michal): confirm the gh identity used for t-20's `gh api` writes is a repo admin.** Ruleset, immutable-releases and vulnerability-alerts writes need admin. After t-20 lands, only an admin can create v* tags, so the coordinator's release flow (v0.1 autonomous mandate) must keep running under an admin identity, or releases stop.
- **You (Michal): decide D8 if you object to a keychain entry.** Under the provisional default, an unpackaged `pnpm dev:desktop` on your Mac writes an "Electron Safe Storage" keychain item, and may prompt for it.
- Not a blocker, but must be scheduled: PR CI builds are unsigned, so a hardened-runtime entitlement regression (t-23's allow-jit-only plist) surfaces only on a signed build. I (Claude) cut v0.2.0-rc.1 first after merge, before any final tag (risk).
