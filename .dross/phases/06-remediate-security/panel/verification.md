# Planner draft — verification lens

Method: for each criterion I wrote the test that would prove it first (the surface,
the input, the observable that flips), then cut the smallest task that makes that
test satisfiable. Every gate below is meant to be red before its task and green
after it. No gate depends on a later task landing. Where a criterion can only be
seen in a real artefact (fuses, live repo settings, CI on three OSes), the task
that makes it observable is ordered after the task that makes it true. That costs
waves on purpose.

Workflow-editing tasks (t-11, t-12, t-18, t-22): before editing, the executor reads
`~/.claude/memory/reference_ci_supply_chain_hardening.md` and audits the file against
it (global CI hygiene rule).

```
Phase 06-remediate-security — 23 tasks across 7 waves

Wave 1
  t-1  Pin Kit upgrades, allowlist phase, ignore audits
       files:    package.json, pnpm-lock.yaml, .gitleaks.toml, .gitignore,
                 scripts/lockfile.spec.ts (new), scripts/repo-hygiene.spec.ts
       desc:     @sveltejs/kit ^3.1.1 and @sveltejs/adapter-node ^6.0.1; @electron/fuses
                 joins devDependencies at an exact x.y.z (t-14 reads the wire with it).
                 Every lockfile change in the phase lands here, so no parallel task
                 regenerates pnpm-lock.yaml. .gitleaks.toml tests.json allowlist gains
                 ^\.dross/phases/06-remediate-security/tests\.json$. .gitignore gains
                 .dross/security/. Executor observes `pnpm install --frozen-lockfile`
                 clean, then the full unit suite, before committing.
       covers:   c-12, c-17
       contract: - gitleaks-config.spec 'every phase allowlisted' is red on this branch
                   today (06 has a spec.toml); it goes green only with the exact
                   anchored 06 path
                 - if pnpm-lock.yaml resolves @sveltejs/kit < 3.1.1 or
                   @sveltejs/adapter-node < 6.0.1 under any importer or snapshot key,
                   lockfile.spec 'kit and adapter-node at patched versions' fails
                 - if @electron/fuses is not an exact x.y.z devDependency,
                   lockfile.spec fails
                 - if `git check-ignore -q .dross/security/<probe>` returns non-zero
                   (or, in a git-less Stryker sandbox, .gitignore lacks a line matching
                   exactly `.dross/security/`), repo-hygiene.spec 'audit findings
                   ignored' fails
                 - if any path under .dross/security/ is tracked (`git ls-files`),
                   repo-hygiene.spec fails
       depends:  —

Wave 2 (each depends t-1: until t-1 lands the unit suite is red for an unrelated
reason, and every gate below runs against patched Kit)

  t-2  Bind alert secrets to their destination
       files:    src/lib/server/alerts/smtp.ts, src/lib/server/alerts/smtp.spec.ts,
                 src/lib/server/alerts/ntfy.ts, src/lib/server/alerts/ntfy.spec.ts,
                 src/lib/server/alerts/channels.spec.ts
       desc:     SMTP parse refuses (exported message constant, nothing saved) a blank
                 password when the previous config exists and host (case-insensitive),
                 port or username differ. ntfy parse refuses a blank token when the
                 topic's origin differs and a token is saved. A `clear_token` form field
                 sets token null with the topic kept; clear plus a typed token is
                 refused as ambiguous. Same destination plus blank secret keeps the
                 saved one, as today. ntfy.spec's deliberate "token survives an origin
                 change" test is inverted.
       covers:   c-1, c-2, c-20
       contract: - if smtp parse with previous {host:a.example, port 587, user u} and
                   form {host:b.example, password:''} returns ok, smtp.spec 'new host
                   needs the password' fails; same for port 465 and username v
                 - if host 'A.EXAMPLE' versus saved 'a.example' with a blank password is
                   refused, smtp.spec 'host case is not a new destination' fails
                 - if ntfy parse with a saved token and a topic moving from
                   https://ntfy.private.invalid to https://ntfy.sh with a blank token
                   returns ok, ntfy.spec 'new origin needs the token' fails
                 - if a saved token is null and the origin changes with a blank token,
                   and parse refuses, ntfy.spec fails (nothing to leak, so save is
                   allowed)
                 - if clear_token with a blank token leaves token non-null, or drops the
                   topic, ntfy.spec 'clear token keeps the channel' fails; clear plus a
                   typed token returning ok fails the 'ambiguous' row
                 - if saveChannel after a refused destination change wrote anything
                   (decrypted config differs from before), channels.spec 'refused save
                   writes nothing' fails
                 - c-20: if re-saving SMTP with identical host/port/username and a blank
                   password changes the stored password, or the in-repo test SMTP server
                   (testing/smtp-server.ts) then sees a failed AUTH on send, smtp.spec
                   'blank re-save keeps the login' fails; if the ntfy fetch stub sees no
                   `Authorization: Bearer <saved>` after a blank same-origin re-save,
                   ntfy.spec fails
       depends:  t-1

  t-3  Claim Check-now atomically per cooldown
       files:    src/lib/server/checks.ts, src/lib/server/checks.spec.ts,
                 src/routes/watches/[id]/page.server.spec.ts
       desc:     checkNow claims the watch with one conditional UPDATE (lastCheckedAt =
                 now WHERE id AND (lastCheckedAt IS NULL OR <= now - cooldown)
                 RETURNING) before calling check; no row returned = cooldown (or
                 not_found if the watch is gone). recordCheck keeps writing the same
                 `now` on success and on failure.
       covers:   c-4, c-21
       contract: - if five concurrent checkNow calls on one never-checked watch, with a
                   check stub that resolves only after all five are in flight, call the
                   stub more than once, checks.spec 'one fetch per cooldown window'
                   fails; the other four must be { kind: 'cooldown' } with
                   COOLDOWN_MESSAGE
                 - if a failing check result leaves lastCheckedAt at anything but the
                   attempt time, or checkNow at attempt+14:59 calls check, checks.spec
                   'failure starts the cooldown' fails
                 - if checkNow at attempt+15:00 after a failure does not call check,
                   checks.spec 'later Check-now runs' fails
                 - if a check stub that throws leaves the watch claimable at once,
                   checks.spec 'a thrown check still holds the cooldown' fails
                 - if the route's ?/check action returns anything but the existing
                   cooldown failure for the second of two parallel POSTs,
                   watches page.server.spec fails
       depends:  t-1

  t-4  Enforce Origin and deny framing in hooks
       files:    src/lib/server/local-request.ts, src/lib/server/local-request.spec.ts,
                 src/hooks.server.ts, e2e/node-server.ts, e2e/dev-guard.e2e.ts (new)
       desc:     The local-request handle also rejects POST/PUT/PATCH/DELETE whose
                 Origin is missing or is not exactly http://<Host> with a plain 403,
                 in every mode, and sets X-Frame-Options: DENY on every response it
                 resolves. node-server.ts gains startDevServer (`vite dev` on a free port,
                 temp DB, the e2e key, SCHEDULER_DISABLED=1). The comment in
                 hooks.server.ts claiming Kit's check covers dev is corrected.
       covers:   c-5, c-6, c-19
       contract: - if a POST with Origin https://evil.example reaches resolve,
                   local-request.spec 'foreign Origin refused' fails; same for a POST
                   with no Origin and for Origin http://127.0.0.1:<other port>
                 - if a POST whose Origin equals http://<Host> is refused, or a GET with
                   a foreign Origin is refused (navigations), local-request.spec fails
                 - if a resolved 200, 404 or 500 response lacks X-Frame-Options: DENY,
                   local-request.spec 'every response denies framing' fails
                 - under a real `vite dev`: if any entry of e2e/action-endpoints.ts
                   ACTION_ENDPOINTS answers a forged-Origin form POST with anything but
                   403, or the DB snapshot differs afterwards, dev-guard.e2e fails
                   (red today: Kit's own check is compiled out of dev)
                 - c-19 dev half: if GET / under `vite dev` in a Playwright browser is
                   not 200 with the watchlist rendered, or the page's own add-watch form
                   (an unsupported .invalid URL) gets 403 instead of the action's 400,
                   dev-guard.e2e 'dev still works in a browser' fails
       depends:  t-1

  t-5  Add strict CSP and violation collector
       files:    vite.config.ts, e2e/security-headers.e2e.ts (new), e2e/desktop/launch.ts,
                 e2e/desktop/csp.e2e.ts (new)
       desc:     Kit csp config (mode auto): default-src 'self'; script-src 'self' (Kit
                 adds hashes/nonces); img-src 'self' https://m.media-amazon.com;
                 frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action
                 'self'; style-src 'self' 'unsafe-inline'. launchDesktop installs a
                 securitypolicyviolation listener plus a console 'Content Security
                 Policy' matcher on every window and asserts zero at dispose. The
                 executor checks e2e seed image URLs are on m.media-amazon.com or null.
       covers:   c-6, c-23
       contract: - on the preview build, if '/', '/account/alerts', a seeded
                   '/watches/<id>' or a 404 page lacks a CSP header whose frame-ancestors
                   is exactly 'none', security-headers.e2e fails
                 - if script-src holds 'unsafe-inline', 'unsafe-eval', any http(s)
                   origin, or any token other than 'self', 'nonce-…' or 'sha256-…',
                   security-headers.e2e fails
                 - if img-src is not exactly {'self', https://m.media-amazon.com},
                   security-headers.e2e fails
                 - if the collector is dead: csp.e2e injects an <img> on an .invalid host
                   and an inline <script> into the live window and must record exactly
                   two violations; a collector that records nothing fails it
                 - if any desktop e2e test produces a CSP violation (a blocked chart
                   style, a seeded image off the CDN, Kit's bootstrap script), that
                   test's dispose fails naming the directive and blocked URI
       depends:  t-1

  t-6  Ignore wall phrases on product pages
       files:    src/lib/server/shops/amazon/classify.ts,
                 src/lib/server/shops/amazon/classify.spec.ts
       desc:     A validateCaptcha form stays decisive. The BOT_WALL_TEXT phrases count
                 only on a page with no #productTitle (a real wall never has one).
       covers:   c-7
       contract: - for each of the four BOT_WALL_TEXT phrases, injected into the first
                   review of recorded-plain.html and separately into its first
                   #feature-bullets item (in memory, fixtures untouched): if classify
                   returns anything but ok with the manifest's title and pricePence,
                   classify.spec 'review/bullet phrase is not a wall' fails (red today)
                 - if any FIXTURES entry with expect.reason 'blocked' stops classifying
                   blocked, the existing fixtures.spec corpus table fails
                 - if the phrase path is dead (synthetic-captcha with its form removed
                   and no #productTitle classifies anything but blocked), classify.spec
                   'phrase-only wall still blocked' fails
       depends:  t-1

  t-7  Force https short links, linear nav
       files:    src/lib/server/shops/amazon/url.ts, src/lib/server/shops/amazon/url.spec.ts,
                 src/lib/server/shops/amazon/short-link.spec.ts, src/lib/nav.ts,
                 src/lib/nav.spec.ts
       desc:     normaliseAmazonUrl returns short links with protocol https:, so the
                 first request and every Location hop (each goes back through it) is
                 https. normalise() strips trailing slashes with a backward character
                 scan, no regex.
       covers:   c-14, c-16
       contract: - if normaliseAmazonUrl('http://amzn.to/abc') is not
                   {kind:'short', url:'https://amzn.to/abc'}, url.spec fails; same for
                   http://amzn.eu/d/xyz
                 - if any URL a recording fake ShopClient receives during
                   resolveShortLink('http://amzn.to/abc'), including a hop whose Location
                   is http://amzn.eu/d/next, does not start with 'https:', short-link.spec
                   'no plaintext request' fails
                 - if navItems({pathname: '/a' + '/'.repeat(16384) + 'x'}) takes 10 ms or
                   more (performance.now, plain Node, best of 3), nav.spec 'linear on
                   slash runs' fails (about 100 ms today)
                 - if normalise differs from the old /\/+$/ replace on the corpus ['',
                   '/', '//', '///', '/account/alerts', '/account/alerts/',
                   '/account/alerts///', '/a//b/', 'a/'], nav.spec 'same output' fails
       depends:  t-1

  t-8  Gate desktop server, drop key from env
       files:    src/desktop/server.ts, src/desktop/server.spec.ts
       desc:     startDesktopServer makes a 32-byte random secret per call and exposes
                 `sessionCookie {name, value}` on DesktopServer. After the Host check,
                 every request except GET /health (exact path, any query) without that
                 cookie value (timingSafeEqual) gets 403 before the handler runs, static
                 /_app/immutable/* included. loadAdapterHandler deletes
                 ALERTS_ENCRYPTION_KEY from process.env once the handler module (whose
                 load runs Kit init) has resolved.
       covers:   c-3, c-13
       contract: - over real node:http against a recording handler: if GET /, GET
                   /account/alerts/__data.json, GET /_app/immutable/x.js or a form POST
                   without the cookie reaches the handler, server.spec 'no secret, 403'
                   fails
                 - if GET /health or GET /health?x=1 without the cookie is refused, or
                   HEAD /health, POST /health or GET /health/ without it is let
                   through, server.spec 'only GET /health is exempt' fails
                 - if a wrong value, a prefix of the value, or the right value under
                   another cookie name is accepted, server.spec fails; the right value
                   among other cookies must pass
                 - if two startDesktopServer calls share a secret, server.spec fails
                 - if process.env still holds ALERTS_ENCRYPTION_KEY after
                   loadAdapterHandler resolves, or the fake handler module did not see it
                   during its import, server.spec 'key gone after load' fails
       depends:  t-1

  t-9  Add env-gated file control channel
       files:    src/desktop/e2e-control.ts (new), src/desktop/e2e-control.spec.ts (new),
                 src/desktop/boundary.spec.ts
       desc:     takeE2eControlDir(env) reads and deletes PRICE_CHECK_E2E_CONTROL_DIR
                 (absolute paths only). startE2eControl(dir, handlers) polls the dir for
                 <id>.req.json, runs one of a fixed set of named handlers (pid, info,
                 updaterPublished, updaterStatus, updaterCheckNow, updaterRestart, quit,
                 keyBackend) and writes <id>.res.json via temp + rename. No eval.
       covers:   c-27
       contract: - if takeE2eControlDir returns non-null for an unset or relative value,
                   or leaves the variable in env, e2e-control.spec fails
                 - if startE2eControl is reached with the variable unset (fake fs records
                   any call), e2e-control.spec 'inactive unless set' fails
                 - if an unknown command, or {cmd:'eval'}, does anything but write
                   {ok:false, error:'unknown command'} with no handler called,
                   e2e-control.spec fails
                 - if net.Server.prototype.listen, dgram createSocket or
                   http.createServer is called during a session (spied), e2e-control.spec
                   'no network listener' fails
                 - if e2e-control.ts imports node:net, node:http(s), node:dgram, node:tls,
                   node:inspector or node:vm, or contains eval( / new Function,
                   boundary.spec fails
                 - with a real temp dir: if a pid request does not produce a res file
                   holding the handler's pid within 2 s, e2e-control.spec fails
       depends:  t-1

  t-10 Wrap alerts.key with safeStorage
       files:    src/desktop/alerts-key.ts, src/desktop/alerts-key.spec.ts,
                 src/desktop/main.ts
       desc:     loadOrCreateAlertsKey(keyFile, keyStore?) takes an injected safeStorage
                 slice. A real backend (macOS, Windows, Linux backend not basic_text):
                 new keys are written wrapped ('pcw1:' + base64 ciphertext); an existing
                 raw key is rewritten wrapped (temp + fsync + rename); if wrapping
                 throws, the raw file stays and its key is used. A wrapped file whose
                 decrypt fails throws AlertsKeyError naming the path and is never
                 replaced. main.ts passes Electron's safeStorage only when
                 app.isPackaged.
       covers:   c-24, c-25
       contract: - fake keyStore, real backend, empty dir: if the file holds the raw
                   base64 key or lacks the 'pcw1:' prefix, alerts-key.spec 'new key
                   wrapped' fails
                 - backend 'basic_text': if the file is not raw base64 at mode 0600
                   (POSIX), alerts-key.spec 'basic_text keeps raw' fails
                 - existing raw v0.1.5 file plus real backend: if the returned key
                   differs from the raw one, or the file is not wrapped afterwards,
                   alerts-key.spec 'raw migrated' fails; a channel sealed under the
                   raw key must open with the returned key (crypto.ts openConfig)
                 - encryptString throws: if the file bytes change or the returned key
                   differs, alerts-key.spec 'wrap failure keeps raw' fails
                 - wrapped file plus decrypt throws: if no AlertsKeyError is thrown, its
                   message holds key bytes, or the file changes, alerts-key.spec fails
                 - no keyStore passed: if behaviour differs from today's tests, the
                   existing alerts-key.spec rows fail
       depends:  t-1

  t-11 Audit shipped devDependencies too
       files:    scripts/audit-shipped.ts (new), scripts/audit-shipped.spec.ts (new),
                 .github/workflows/audit.yml
       desc:     Reads `pnpm audit --json` and fails on high or critical advisories whose
                 path root is a production dependency or one of SHIPPED_DEV (electron,
                 @sveltejs/kit, svelte, @sveltejs/adapter-node). It fails closed on JSON
                 it cannot parse. audit.yml runs it in place of `--prod`.
       covers:   c-11
       contract: - fixture audit JSON with a high advisory on path
                   '.>@sveltejs/kit>devalue': if the CLI exits 0, audit-shipped.spec
                   fails; same for '.>electron>…' and '.>nodemailer'
                 - a high advisory only on '.>drizzle-kit>esbuild', or a moderate one on
                   kit: if the CLI exits non-zero, audit-shipped.spec fails
                 - empty or truncated input: if the CLI exits 0, audit-shipped.spec fails
                 - if a SHIPPED_DEV name is not a devDependency in package.json, or
                   audit.yml still passes --prod or does not run audit-shipped.ts,
                   audit-shipped.spec fails
       depends:  t-1

  t-12 Check live repo security settings
       files:    scripts/repo-settings.ts (new), scripts/repo-settings.spec.ts (new),
                 .github/workflows/repo-settings.yml (new)
       desc:     A pure evaluate(snapshot) plus a fetcher with injected fetch, using Node
                 built-ins only. It requires: an active tag ruleset covering
                 refs/tags/v* with creation, update and deletion rules, whose only bypass
                 is RepositoryRole admin; environment release with only a tag-type v*
                 policy and protected_branches false; immutable releases enabled;
                 vulnerability alerts enabled. A missing token or any non-2xx is a
                 violation. Workflow: push to main, weekly schedule, workflow_dispatch;
                 contents: read; no install; GH_TOKEN from secrets.REPO_SETTINGS_TOKEN.
       covers:   c-9, c-10, c-11
       contract: - for each fixture snapshot (no tag ruleset; ruleset enforcement
                   'evaluate'; include refs/tags/* without v*; creation rule missing; a
                   bypass actor other than admin; environment with a branch-type v*
                   policy; immutable releases {enabled:false}; vulnerability-alerts 404),
                   if evaluate returns no violation, repo-settings.spec fails
                 - the all-good snapshot: if evaluate returns any violation,
                   repo-settings.spec fails
                 - if the CLI exits 0 with GH_TOKEN unset, or on a 403/500 from any
                   endpoint, repo-settings.spec 'fails closed' fails
                 - if repo-settings.yml lacks the push-main or schedule trigger, runs an
                   install, or the token reaches any step but the check, repo-settings.spec
                   fails; `pnpm ci:policy` must stay 0
       depends:  t-1

  t-13 Add pinned signing toolchain and signer
       files:    signing/package.json (new), signing/pnpm-lock.yaml (new),
                 scripts/sign-mac.ts (new), scripts/sign-mac.spec.ts (new)
       desc:     signing/ holds only electron-builder at the root devDependency's exact
                 version, with its own frozen lockfile (installed with
                 --ignore-workspace). sign-mac.ts --version <v> --app <path.app> loads
                 electron-builder through createRequire from signing/, refuses missing
                 signing variables (reuses missingSigningVariables), and builds
                 dmg+zip from the prepackaged app with builderConfig({sign:true}).
       covers:   c-26
       contract: - if signing/package.json has any dependency besides electron-builder,
                   or its version differs from package.json's devDependency, or
                   signing/pnpm-lock.yaml importers list anything else, sign-mac.spec
                   fails
                 - if sign-mac.ts or anything it imports transitively (package-desktop.ts,
                   src/desktop/app-id.ts) has a runtime import other than node:*,
                   relative files or `import type`, sign-mac.spec 'runs without the
                   project install' fails
                 - with an injected resolver and build: if the builder is resolved from
                   anywhere but signing/, the call lacks `prepackaged: <app>`, or its
                   config differs from builderConfig({version, sign:true}), sign-mac.spec
                   fails
                 - if a missing CSC_LINK (or any of the five) does not exit non-zero
                   naming only the missing names, or --app is not an existing .app dir
                   and the build still runs, sign-mac.spec fails
       depends:  t-1

  t-14 Verify fuse wire and entitlements
       files:    scripts/verify-packaged.ts, scripts/verify-packaged.spec.ts
       desc:     New `fuses <exe>` mode reads the wire with @electron/fuses and requires
                 RunAsNode, EnableNodeOptionsEnvironmentVariable,
                 EnableNodeCliInspectArguments and GrantFileProtocolExtraPrivileges off,
                 and EnableEmbeddedAsarIntegrityValidation and OnlyLoadAppFromAsar on.
                 `mac --signed` also reads `codesign -d --entitlements - --xml` and
                 refuses com.apple.security.cs.disable-library-validation.
       covers:   c-8
       contract: - with an injected wire reader: for each of the six fuses flipped the
                   wrong way, if verifyFuses returns no violation naming that fuse,
                   verify-packaged.spec fails; a wire missing a fuse is a violation too
                 - the all-correct wire: if any violation is returned, verify-packaged.spec
                   fails
                 - fake runner with entitlements XML containing disable-library-validation:
                   if verifyMac --signed passes, verify-packaged.spec fails; the unsigned
                   path must not run the entitlements command
                 - if the CLI usage string or runCli does not route `fuses`,
                   verify-packaged.spec fails
       depends:  t-1

Wave 3
  t-15 Add clear-token control to alerts page
       files:    src/routes/account/alerts/+page.svelte,
                 src/routes/account/alerts/page.svelte.spec.ts,
                 src/routes/account/alerts/page.server.spec.ts,
                 src/routes/account/alerts/alerts.e2e.ts
       desc:     The ntfy card shows a "Remove the saved token" checkbox (name
                 clear_token) only while tokenSet. The destination-change refusal from
                 t-2 shows inline in that channel's card.
       covers:   c-1, c-2
       contract: - if the checkbox renders when tokenSet is false, or not when true,
                   page.svelte.spec fails
                 - if ?/save with clear_token leaves tokenSet true, or removes the ntfy
                   card, page.server.spec 'clear token keeps channel' fails
                 - if ?/save moving the topic to another origin with a blank token
                   returns anything but fail(400, {kind:'ntfy', message}) and an
                   unchanged loaded topic, page.server.spec fails; same for SMTP host
                 - preview e2e: if the destination-change refusal does not show inside the
                   ntfy card, or after reload the topic shown is the new one,
                   alerts.e2e fails
       depends:  t-2

  t-16 Set session cookie before window loads
       files:    src/desktop/window.ts, src/desktop/window.spec.ts, src/desktop/main.ts,
                 e2e/desktop/guard.e2e.ts
       desc:     WindowDeps gains a session cookie setter. createMainWindow and the
                 showWindow reload paths await cookies.set({url: origin, name, value,
                 httpOnly: true, sameSite: 'strict'}, no expirationDate) before any
                 loadURL. main.ts feeds it server.sessionCookie. guard.e2e's raw-request
                 rows are rewritten for the gate.
       covers:   c-3, c-13
       contract: - if loadURL is called before the fake cookie-set promise resolves, or
                   the cookie lacks httpOnly, has sameSite other than 'strict', carries
                   an expirationDate or targets another URL, window.spec fails
                 - desktop e2e, raw node:http with no cookie: if GET
                   /account/alerts/__data.json, GET / or any ACTION_ENDPOINTS POST (with
                   matching Host and Origin) is not 403, or the DB snapshot changes,
                   guard.e2e 'no secret, no access' fails; GET /health must stay 200
                 - if the same raw GET / with the window's own cookie (read via
                   session.cookies.get in app.evaluate) is not 200, guard.e2e fails (the
                   cookie, not something else, is the gate)
                 - c-13: if app.evaluate sees ALERTS_ENCRYPTION_KEY in main's process.env
                   after startup, or the ntfy channel saved in the window shows as
                   unreadable after a relaunch, guard.e2e 'key out of env, channels still
                   decrypt' fails
                 - "window works unchanged": the whole desktop e2e suite is the gate;
                   any test that loads a page and gets 403 fails
       depends:  t-8, t-10

  t-17 Apply tag ruleset, immutability, Dependabot
       files:    .github/rulesets/release-tags.json (new), scripts/rulesets.spec.ts
       desc:     The committed tag ruleset is applied with `gh api`, alongside PUT
                 immutable-releases and PUT vulnerability-alerts. BLOCKER: You (Michal)
                 create a fine-grained read-only token (this repo; Administration read,
                 Metadata read) as secret REPO_SETTINGS_TOKEN. I (Claude) cannot mint
                 it. No reviewer is added to release (locked).
       covers:   c-9, c-10, c-11
       contract: - if release-tags.json is not target 'tag', enforcement 'active',
                   include exactly ['refs/tags/v*'], rules including creation, update
                   and deletion, and bypass_actors exactly [RepositoryRole 5 (admin),
                   always], rulesets.spec 'tag ruleset' fails
                 - live: `node scripts/repo-settings.ts` is observed exiting 1 before the
                   apply (it names the missing ruleset, immutability and alerts) and 0
                   after; a workflow_dispatch run of repo-settings.yml is observed green
       depends:  t-12

  t-18 Split signing out of release build
       files:    .github/workflows/release.yml, scripts/release-workflow.spec.ts,
                 scripts/workflow-policy.ts, scripts/workflow-policy.spec.ts
       desc:     build-macos packages unsigned with no environment and no secrets, and
                 uploads the .app as a tar (upload-artifact drops framework symlinks).
                 sign-macos (environment release) checks out, installs only signing/
                 (frozen, --ignore-workspace), and runs sign-mac.ts. Its step sets
                 `trap 'rm -f "$RUNNER_TEMP/AuthKey.p8"' EXIT` before decoding the key.
                 verify-macos (no secrets) runs layout, mac --signed and the packaged
                 smoke on the signed artefact. publish needs verify-macos.
                 workflow-policy gains a signing-job rule: any job referencing a
                 signing secret may run only an allowlist of commands, and must trap the
                 .p8 before writing it.
       covers:   c-15, c-26
       contract: - fixture workflows: if the secret-bearing job contains `pnpm install`
                   (root), `pnpm build`, `pnpm build:desktop`, `pnpm test…`,
                   `pnpm package:desktop`, `npx`, `npm` or `node scripts/<anything but
                   sign-mac.ts>` and checkWorkflow reports nothing, workflow-policy.spec
                   fails
                 - if a step writes AuthKey.p8 with no `trap … rm -f
                   "$RUNNER_TEMP/AuthKey.p8"' EXIT`, or the trap comes after the write,
                   and no violation is reported, workflow-policy.spec fails
                 - if `pnpm ci:policy` on the shipped tree exits non-zero,
                   workflow-policy.spec 'shipped workflows clean' fails
                 - if CSC_LINK, CSC_KEY_PASSWORD or APPLE_API_* appear anywhere but
                   sign-macos's sign step env, or environment: release is on any other
                   job, release-workflow.spec fails
                 - if publish does not need verify-macos, or verify-macos holds a secret
                   or an environment, or build-macos still signs, release-workflow.spec
                   fails
       depends:  t-13

Wave 4
  t-19 Drive packaged app without the inspector
       files:    src/desktop/main.ts, e2e/packaged/launch-packaged.ts,
                 e2e/packaged/smoke.packaged.ts, e2e/packaged/update.packaged.ts
       desc:     main.ts reads the control dir before the env swap, wires the t-9
                 handlers, and hands the variable over to the installer like the output
                 capture. The harness spawns the exe itself with
                 --remote-debugging-port=0 (plus --use-mock-keychain on darwin), reads
                 DevToolsActivePort from userData, connects with
                 chromium.connectOverCDP, and replaces every app.evaluate with control
                 calls. _electron is no longer imported.
       covers:   c-22, c-27
       contract: - if launch-packaged.ts imports _electron, or the args it spawns
                   include anything matching /^--inspect/, the static check in
                   smoke.packaged 'no inspector' fails
                 - if the app's argv, from the control 'info' command, contains --inspect
                   or --inspect-brk, smoke.packaged fails
                 - if main.ts does not wire the control channel, every packaged test
                   fails at launch (no pid reply within the timeout), so this cannot
                   pass vacuously
                 - pnpm test:e2e:packaged is observed green locally on macOS before
                   commit (fuses still at defaults, so this isolates the harness change)
       depends:  t-9, t-16

Wave 5
  t-20 Flip fuses, ship tightened entitlements
       files:    scripts/package-desktop.ts, scripts/package-desktop.spec.ts,
                 build-resources/entitlements.mac.plist (new)
       desc:     builderConfig sets electronFuses (runAsNode,
                 enableNodeOptionsEnvironmentVariable, enableNodeCliInspectArguments,
                 grantFileProtocolExtraPrivileges false;
                 enableEmbeddedAsarIntegrityValidation, onlyLoadAppFromAsar true), and
                 mac.entitlements plus entitlementsInherit on the new plist (allow-jit
                 only).
       covers:   c-8
       contract: - if builderConfig().electronFuses differs in any of the six values,
                   package-desktop.spec 'fuses' fails
                 - if mac.entitlements or entitlementsInherit is unset or not the plist,
                   or the plist contains disable-library-validation or
                   allow-dyld-environment-variables, or lacks allow-jit,
                   package-desktop.spec fails
                 - a local `pnpm package:desktop` then `verify-packaged.ts fuses <exe>` is
                   observed exiting 0, and pnpm test:e2e:packaged (smoke and update) is
                   observed green on that fused build before commit
       depends:  t-19

  t-21 Assert key wrapping in packaged app
       files:    e2e/packaged/smoke.packaged.ts, e2e/desktop/seed-child.ts
       desc:     A fresh packaged launch asserts alerts.key form by backend (control
                 'keyBackend'). A migration test seeds a raw v0.1.5-style key plus an
                 ntfy channel sealed under it (seed-child), launches, and asserts the
                 file is wrapped and the alerts page shows the saved topic.
       covers:   c-24, c-25
       contract: - darwin and win32: if alerts.key after the first launch parses as raw
                   (parseAlertsKey succeeds) or lacks 'pcw1:', smoke.packaged 'key
                   wrapped' fails; linux on basic_text: if it is not raw at 0600, it fails
                 - if after the migration launch the ntfy card shows the unreadable state
                   instead of the seeded topic, or (darwin/win32) the file is still raw,
                   smoke.packaged 'v0.1.5 key migrated' fails
       depends:  t-19, t-10

Wave 6
  t-22 Check fuses in CI and release
       files:    .github/workflows/ci.yml, .github/workflows/release.yml,
                 scripts/ci-packaged.spec.ts, scripts/release-workflow.spec.ts
       desc:     A `node scripts/verify-packaged.ts fuses "$PRICE_CHECK_PACKAGED_EXE"`
                 step goes after locating the exe in ci.yml's packaged job and in
                 release.yml's verify-macos, build-windows and build-linux, before the
                 packaged smoke.
       covers:   c-8, c-22
       contract: - if any release.yml job that runs the packaged smoke lacks the fuses
                   step before it, release-workflow.spec fails; same for ci.yml in
                   ci-packaged.spec
                 - the PR's CI is observed green on linux, macos and windows with fuses
                   on: the packaged e2e passes without the inspector (c-22), and the
                   fuses step passes on each OS (a wrong fuse would fail it)
       depends:  t-20, t-14, t-18

Wave 7
  t-23 Re-audit and run every gate
       files:    .dross/security/state.toml (gitignored, private)
       desc:     Run /dross-secure on the phase branch, then mark SEC-01..17 resolved or
                 dismissed. SEC-12 and the SEC-14 queue cap are dismissed with their
                 locked-decision reasons. Run pnpm test:unit --run, pnpm lint, pnpm
                 check, pnpm test:e2e (preview plus dev-guard), pnpm test:e2e:desktop,
                 and observe CI's packaged e2e on all three OSes.
       covers:   c-18, c-19, c-22
       contract: - if the fresh run's reconcile reports any new or regressed finding at
                   medium or higher, c-18 fails
                 - if any of SEC-01..SEC-17 is absent from state.toml or has a status
                   other than resolved or dismissed, c-18 fails
                 - c-19: if dev-guard.e2e 'dev still works in a browser' or the packaged
                   e2e is red with the session gate and fuses both in place, c-19 fails;
                   each command's output is read before anything is reported green
       depends:  t-1 … t-22
```

## Coverage

| Criterion | Tasks |
|---|---|
| c-1 | t-2, t-15 |
| c-2 | t-2, t-15 |
| c-3 | t-8, t-16 |
| c-4 | t-3 |
| c-5 | t-4 |
| c-6 | t-4 (X-Frame-Options), t-5 (frame-ancestors) |
| c-7 | t-6 |
| c-8 | t-14, t-20, t-22 |
| c-9 | t-12, t-17 |
| c-10 | t-12, t-17 |
| c-11 | t-11 (audit), t-12 + t-17 (Dependabot alerts live and checked) |
| c-12 | t-1 |
| c-13 | t-8, t-16 |
| c-14 | t-7 |
| c-15 | t-18 |
| c-16 | t-7 |
| c-17 | t-1 |
| c-18 | t-23 |
| c-19 | t-4 (dev half), t-23 (full gate with c-3 and c-8 in place) |
| c-20 | t-2 |
| c-21 | t-3 |
| c-22 | t-19, t-22, t-23 |
| c-23 | t-5 |
| c-24 | t-10, t-21 |
| c-25 | t-10, t-21 |
| c-26 | t-13, t-18 |
| c-27 | t-9, t-19 |

27/27 criteria covered.

## Judgment calls

- **Wave 1 is t-1 alone.** I rejected a wide parallel wave 1. gitleaks-config.spec 'every phase allowlisted' is red on this branch today, so no other task's unit gate could go green before t-1, and every gate should run against the patched Kit.
- **All lockfile changes go in t-1.** That includes @electron/fuses. I rejected adding deps per task, because parallel tasks regenerating pnpm-lock.yaml conflict.
- **No two tasks in the same wave share a file.** main.ts edits are spread out: t-10 (w2), t-16 (w3), t-19 (w4). package-desktop.ts: t-20 only (t-13 reuses it read-only). release.yml: t-18 (w3), then t-22 (w6). That forces some waves deeper than the dependency graph alone would.
- **The session secret is generated inside startDesktopServer and exposed on DesktopServer.** I rejected generating it in main.ts, because the gate's unit test should own the secret's lifecycle and it would add one more main.ts edit in wave 2.
- **The gate lives in the node:http wrapper (server.ts), not a Kit hook.** sirv serves /_app/immutable/* before hooks run. Preview and dev stay ungated, as the locked decision says.
- **The Check-now claim is a conditional UPDATE on lastCheckedAt.** I rejected an in-memory in-flight map, because a thrown check would leave no cooldown and break c-21. I rejected a new claim column, because it is a migration for no extra guarantee.
- **The Origin guard rejects unsafe methods with a missing or mismatched Origin, in every mode.** I rejected relying on Kit (its check is compiled out of dev) and rejected letting a missing Origin through (that is a raw local client).
- **c-6 is split: X-Frame-Options in the hook (t-4), frame-ancestors in Kit's CSP (t-5).** This keeps hooks.server.ts and vite.config.ts in separate parallel tasks.
- **style-src keeps 'unsafe-inline'.** The spec constrains only script-src and img-src, and Svelte style attributes and app.html's inline style need it. I rejected style hashes as scope creep.
- **img-src allows only m.media-amazon.com, and extractImage is not narrowed.** The audit's refute panel dropped X8. An off-CDN image renders broken rather than loading.
- **The bot-wall phrase only counts on pages without #productTitle.** I rejected subtracting review and bullet containers, because Amazon renames containers and a real wall never has a product title.
- **https is forced in normaliseAmazonUrl, not resolveShortLink.** Every hop goes back through normaliseAmazonUrl, so one change covers the first request and every Location hop.
- **nav normalise uses a backward character scan.** I rejected the lookbehind regex, because its linearity depends on the regex engine (that is the SEC-17 Node-vs-Electron gap).
- **safeStorage is wired only when app.isPackaged.** Unpackaged dev and desktop-e2e runs would otherwise write "Electron Safe Storage" entries into the developer's real keychain, or prompt. c-24 and c-25 are about installs, and they are proven by unit tests plus the packaged smoke. The judge may overrule this if c-24 is read as covering dev runs.
- **c-25's "still sends" is proven by a decrypted card in the packaged app plus the driver unit tests.** I rejected a live Send test from the packaged app, because ntfy needs https, so the shipped app would have to trust a test CA.
- **The control channel is a file mailbox with a fixed command allowlist.** I rejected a stdin pipe (it is lost when the updater relaunches the app, and Windows GUI-subsystem stdio is unreliable). I rejected a unix socket or named pipe (it is a listener, and a Windows named pipe can be reached over SMB). I rejected an eval command (it would reopen the run-JS path the fuses close).
- **Fuses flip only after the harness runs without the inspector.** t-19 is proven on default fuses first, then t-20 flips them. This way a red packaged run points at exactly one change.
- **Signing uses a separate signing/ package with its own frozen lockfile, and sign-mac.ts reuses builderConfig.** I rejected `npx electron-builder@x`, because its dependency tree is not lockfile-pinned. I rejected a committed builder JSON, because it can drift, and a config handed over from an earlier job could inject afterSign hooks into the secret-holding job.
- **The unsigned .app crosses jobs as a tar.** upload-artifact does not preserve the symlinks inside Electron's frameworks, which would break the signature.
- **The signing-job rule goes in workflow-policy.ts (pnpm ci:policy, part of the required static check) as a fail-closed allowlist.** I rejected putting it only in release-workflow.spec, because the spec says "the workflow policy check".
- **The live settings check is its own workflow (push to main, schedule, dispatch) with a read-only fine-grained token, and it fails closed.** I rejected gating release.yml's tag job, because the tagged commit controls release.yml, so an attacker could delete the gate. I rejected GITHUB_TOKEN, because immutable-releases and vulnerability-alerts need Administration read. BLOCKER: You (Michal) create REPO_SETTINGS_TOKEN.
- **The audit uses a filter script over `pnpm audit --json`, scoped to shipped roots.** I rejected dropping `--prod`, because build-only advisories (esbuild, minimatch, qs) would keep CI red for code that never ships. I rejected moving Kit or electron into dependencies, because electron-builder refuses electron there and adapter-node already bundles Kit.
- **c-13's key is scrubbed inside loadAdapterHandler, right after the import.** I rejected scrubbing later in the lifecycle, because the window and tray would already have been created with the key in env.
