# Planner draft — lens: risk

Each task names the failure mode it owns (`risk:`). A risk has exactly one owner. Where two
tasks cover the same criterion, they own different failure modes of it.

```
Phase 06-remediate-security — 25 tasks across 5 waves

Wave 1
  t-1  Lift Kit and adapter-node advisory floors
       files:    package.json, pnpm-lock.yaml, scripts/dependency-floor.spec.ts (new)
       desc:     @sveltejs/kit to ^3.1.1 and @sveltejs/adapter-node to ^6.0.1, lockfile
                 regenerated. The only task that touches pnpm-lock.yaml. The executor
                 observes `pnpm install --frozen-lockfile`, `pnpm build` and the unit
                 suite green on the bumped tree before committing.
       risk:     a range bump that leaves the lockfile on a vulnerable resolution
       covers:   c-12
       contract: if pnpm-lock.yaml's importers['.'] resolves @sveltejs/kit below 3.1.1
                 or @sveltejs/adapter-node below 6.0.1 (semver compare on the resolved
                 version, peer suffix stripped), dependency-floor.spec fails
                 if any packages/snapshots key in pnpm-lock.yaml still names
                 @sveltejs/kit@3.1.0 or @sveltejs/adapter-node@6.0.0 (a second copy
                 pulled in by a peer), dependency-floor.spec fails
       depends:  —

  t-2  Bind saved secrets to their destination
       files:    src/lib/server/alerts/smtp.ts, src/lib/server/alerts/smtp.spec.ts,
                 src/lib/server/alerts/ntfy.ts, src/lib/server/alerts/ntfy.spec.ts
       desc:     smtp parse: a blank password reuses the saved one only when host
                 (case-insensitive), port and username (exact) all match; otherwise it
                 refuses with a message naming the password. ntfy parse: a blank token
                 reuses the saved one only on the same URL origin; a new
                 `clear_token` form field drops the token without removing the channel.
                 The ntfy.spec 'write-only token' case that pins the old keep-on-any-
                 topic behaviour is inverted.
       risk:     the old secret reaches a new host (exfiltration); and the opposite
                 failure, a same-destination re-save silently losing its secret
       covers:   c-1, c-2, c-20
       contract: if smtpDriver.parseConfig with previous {host:'smtp.a.example',port:587,
                 username:'u'} and a blank password accepts host 'smtp.b.example', port
                 465 or username 'U', smtp.spec 'destination change needs the password'
                 fails; the refusal must be {ok:false} with a message containing
                 'password', and no config
                 if a blank password with host 'SMTP.A.EXAMPLE' (case only), port '587'
                 or ' 587 ' does not keep the saved password, smtp.spec fails (no
                 over-refusal on a cosmetic difference)
                 if re-saving the same destination with a blank password and then
                 sending to the local test SMTP server (src/lib/server/testing/
                 smtp-server.ts) does not authenticate with the original password,
                 smtp.spec 'blank re-save still authenticates' fails (c-20)
                 if ntfyDriver.parseConfig keeps the saved token for a blank token when
                 the topic moves from https://ntfy.a.example/t to https://ntfy.sh/t or
                 to https://ntfy.a.example:8443/t, ntfy.spec fails; moving only the
                 topic path on the same origin (or adding an explicit :443) must keep
                 it
                 if a blank token on a new origin is refused when the previous token is
                 null (nothing to leak), ntfy.spec fails
                 if clear_token with a blank token does not give token null on the same
                 or a new origin, or clear_token together with a typed token is
                 accepted (contradictory input), ntfy.spec fails
                 if a refused save's message contains the saved or typed secret, either
                 spec fails (sentinel token/password values)
       depends:  —

  t-3  Add per-launch session gate module
       files:    src/desktop/session-gate.ts (new), src/desktop/session-gate.spec.ts (new)
       desc:     Pure, no electron import: createSessionSecret() (32 random bytes,
                 base64url), SESSION_COOKIE name, cookieDetails(origin, secret) for
                 session.cookies.set, and isAuthorized({method, url, cookieHeader},
                 secret) with GET /health the sole exemption. Not wired yet (t-15), so
                 no commit ever ships a half-gated server.
       risk:     gate bypass through request parsing (path tricks, cookie parsing,
                 timing), and the cookie being readable or persisted
       covers:   c-3
       contract: if isAuthorized is true without the cookie for any of: GET
                 /account/alerts/__data.json, POST /account/alerts?/save, GET
                 /_app/immutable/x.js, HEAD /health, POST /health, GET /health/,
                 GET /Health, GET /health/../account/alerts/__data.json,
                 GET /health/..%2faccount, GET //health, or absolute-form
                 'http://127.0.0.1:1/account', session-gate.spec 'only GET /health is
                 exempt' fails
                 if GET /health and GET /health?x=1 are not authorised without a
                 cookie, session-gate.spec fails
                 if a cookie header that is missing, empty, the wrong value, the right
                 value with one byte changed, a prefix of it, the value under another
                 name, or malformed ('pc=;;=', 300 KB of junk) authorises or throws,
                 session-gate.spec fails; the right cookie among other cookies must
                 authorise
                 if the comparison is not crypto.timingSafeEqual over equal-length
                 buffers (source ?raw check for timingSafeEqual and no ===/includes on
                 the secret), session-gate.spec fails
                 if cookieDetails lacks httpOnly true, sameSite 'strict', url equal to
                 the origin, or carries expirationDate (a persisted cookie), session-
                 gate.spec fails
                 if two createSessionSecret() calls are equal or either decodes to
                 fewer than 32 bytes, session-gate.spec fails
       depends:  —

  t-4  Scrub alerts key from main env
       files:    src/desktop/server.ts, src/desktop/server.spec.ts,
                 e2e/desktop/harness.e2e.ts
       desc:     loadAdapterHandler deletes ALERTS_ENCRYPTION_KEY from process.env once
                 the handler module (and Kit's init hook) has loaded, success or throw.
                 harness.e2e's 'launcher env' assertion that main holds the key is
                 inverted, and it proves a channel saved in the window still opens.
       risk:     scrubbing before Kit's init read the key (server can no longer
                 decrypt) or not scrubbing at all (renderer/children inherit it)
       covers:   c-13
       contract: if a fake handler module that records process.env at import time
                 does not see ALERTS_ENCRYPTION_KEY, or process.env still holds it after
                 loadAdapterHandler resolves, server.spec fails
                 if a handler module whose import throws leaves the key in
                 process.env, server.spec fails
                 if main's process.env (app.evaluate) holds ALERTS_ENCRYPTION_KEY after
                 launch, harness.e2e 'launcher env' fails
                 if, in that launch, an SMTP channel saved through the window's own
                 form reads back on reload as unreadable instead of showing its host,
                 harness.e2e fails (the scrub ran before Kit's init hook took the key)
       depends:  —

  t-5  Enforce Origin on unsafe methods everywhere
       files:    src/lib/server/local-request.ts, src/lib/server/local-request.spec.ts,
                 src/hooks.server.ts, e2e/dev-server.e2e.ts (new)
       desc:     createLocalRequestHandle refuses (403) any non-GET/HEAD/OPTIONS
                 request whose Origin header is present and not http://<Host>, with no
                 dev/building branch, so `pnpm dev` is covered. hooks.server.ts's
                 comment that Kit's CSRF check covers dev is corrected. The new
                 e2e/dev-server.e2e.ts starts `vite dev` on a free port with a temp DB.
       risk:     the check silently depending on Kit's prod-only CSRF path
       covers:   c-5
       contract: if a POST to /?/add with Origin https://evil.example, Origin 'null',
                 or Origin http://127.0.0.1:<other port> gets anything but 403 from the
                 handle, local-request.spec fails, for form, multipart, text/plain and
                 JSON content types
                 if a same-origin POST (Origin http://<Host>), a POST with no Origin, or
                 a cross-origin GET is refused by this check, local-request.spec fails
                 (no over-refusal: raw local clients are c-3's job)
                 if local-request.ts imports $app/env or reads dev/building, the
                 source ?raw check in local-request.spec fails
                 under a real `vite dev`, if a cross-origin form POST to /?/add gets
                 anything but 403, or the same POST with the dev origin gets 403,
                 e2e/dev-server.e2e.ts fails
       depends:  —

  t-6  Ignore wall phrases on product pages
       files:    src/lib/server/shops/amazon/classify.ts,
                 src/lib/server/shops/amazon/classify.spec.ts
       desc:     A validateCaptcha form still marks a wall anywhere. The text phrases
                 are only tested on pages with no product markers (#productTitle,
                 #dp, #ppd), so review or bullet text on a product page cannot force
                 'blocked'. isBotWall (adapter pre-check) and classifyProductPage share
                 the rule. Fixture variants are built in memory: no new committed
                 fixture (r-02).
       risk:     user content forcing 'blocked'; and the inverse, a real wall slipping
                 through as parse_failed
       covers:   c-7
       contract: if recorded-plain.html with "Click the button below to continue
                 shopping." inserted into a review, or "make sure you're not a robot"
                 into a #feature-bullets item, does not classify ok with the manifest's
                 title and price via classifyProductPage, and isBotWall false,
                 classify.spec fails
                 if any manifest entry of shape 'captcha' (recorded-captcha-continue,
                 synthetic-captcha) stops classifying {ok:false, reason:'blocked'}, the
                 manifest loop in classify.spec fails
                 if a bare page with only a wall phrase and no product markers (no
                 form) stops classifying blocked, classify.spec fails
                 if a product page carrying a form[action*=validateCaptcha] stops
                 classifying blocked, classify.spec fails
       depends:  —

  t-7  Force https for short-link hops
       files:    src/lib/server/shops/amazon/url.ts, src/lib/server/shops/amazon/url.spec.ts,
                 src/lib/server/shops/amazon/short-link.ts,
                 src/lib/server/shops/amazon/short-link.spec.ts
       desc:     normaliseAmazonUrl returns an https URL for a short-link (amzn.to /
                 amzn.eu) whatever the pasted scheme; resolveShortLink upgrades every
                 hop, including an http:// Location. Product URLs are unchanged
                 (already rebuilt as https canonical).
       risk:     any plaintext request for a short link, first hop or redirect hop
       covers:   c-14
       contract: if normaliseAmazonUrl('http://amzn.to/abc') or
                 ('http://amzn.eu/d/xyz') yields a short url not starting https://,
                 url.spec fails
                 if resolveShortLink, given http://amzn.to/abc and a fake client whose
                 first hop answers 302 Location: http://amzn.eu/d/xyz, requests any URL
                 whose protocol is http:, short-link.spec fails (fake ShopClient records
                 every requested URL; r-01, no network)
                 if an http:// amazon.co.uk product URL stops normalising to its https
                 canonical, url.spec fails
       depends:  —

  t-8  Linear nav normalise, ignore audit dir
       files:    src/lib/nav.ts, src/lib/nav.spec.ts, .gitignore,
                 scripts/repo-hygiene.spec.ts
       desc:     normalise() trims trailing slashes with an index scan (no regex).
                 .gitignore gains `.dross/security/`.
       risk:     quadratic regex on plain Node; raw audit findings committed publicly
       covers:   c-16, c-17
       contract: if normalise('/a' + '/'.repeat(16384) + 'x') or a pure 16k-slash
                 trailing run takes 10 ms or more (best of 5 under plain Node in
                 vitest's node project), nav.spec fails
                 if any of '', '/', '//', '///', '/a', '/a/', '/a//', '/account/alerts/',
                 '/account//alerts/' gives a different result from today's regex
                 (table computed from the old implementation, kept inline in the spec),
                 nav.spec fails
                 if .gitignore lacks a line ignoring .dross/security/, or
                 `git check-ignore -q .dross/security/x/report.md` exits non-zero,
                 repo-hygiene.spec fails
                 if any tracked file path starts with .dross/security/, repo-hygiene.spec
                 fails
       depends:  —

  t-9  Claim Check-now cooldown atomically
       files:    src/lib/server/checks.ts, src/lib/server/checks.spec.ts
       desc:     checkNow claims the cooldown before fetching with one conditional
                 UPDATE watch SET last_checked_at = now WHERE id = ? AND
                 (last_checked_at IS NULL OR last_checked_at <= now - cooldown)
                 RETURNING id; no row back means 'cooldown'. recordCheck writes the
                 same `now`. A throwing check keeps the claim.
       risk:     TOCTOU letting N concurrent posts start N fetches; a failed or thrown
                 fetch not starting the cooldown
       covers:   c-4, c-21
       contract: if 5 concurrent checkNow calls for one watch, against a check() held
                 on a deferred promise, start check() more than once, or the other four
                 do not return {kind:'cooldown'} with COOLDOWN_MESSAGE, checks.spec
                 'concurrent Check now starts one fetch' fails (real test DB from
                 testing/test-db.ts, not a mock)
                 if a check() returning a failure leaves lastCheckedAt other than the
                 attempt time, or a checkNow at attempt+14:59.999 is not refused, or one
                 at attempt+15:00 does not run, checks.spec fails (c-21 boundary
                 unchanged from today)
                 if a check() that throws leaves lastCheckedAt unclaimed (a retry inside
                 15 min runs again), checks.spec fails
                 if checkNow on an unknown id writes anything or returns other than
                 not_found, checks.spec fails
                 if dueWatches returns a watch while its Check-now fetch is in flight,
                 checks.spec fails (the claim also keeps the scheduler off it)
       depends:  —

  t-10 Turn off Electron fuses, trim entitlements
       files:    scripts/package-desktop.ts, scripts/package-desktop.spec.ts,
                 build-resources/entitlements.mac.plist (new)
       desc:     builderConfig sets electronFuses: runAsNode, enableNodeOptions-
                 EnvironmentVariable, enableNodeCliInspectArguments and
                 grantFileProtocolExtraPrivileges false; enableEmbeddedAsarIntegrity-
                 Validation and onlyLoadAppFromAsar true; resetAdHocDarwinSignature
                 true (unsigned arm64 builds must still launch). mac.entitlements and
                 entitlementsInherit point at the new plist (allow-jit only). The
                 executor observes a local unsigned `pnpm package:desktop` .app launch
                 to its window before committing. The packaged e2e stays red from here
                 until t-24 reworks the harness; no task in between may cite it.
       risk:     fuses or entitlements silently left at app-builder-lib defaults;
                 fused unsigned builds that no longer launch
       covers:   c-8
       contract: if builderConfig({sign}) for sign true or false has any of runAsNode,
                 enableNodeOptionsEnvironmentVariable, enableNodeCliInspectArguments,
                 grantFileProtocolExtraPrivileges not exactly false, or
                 enableEmbeddedAsarIntegrityValidation / onlyLoadAppFromAsar not exactly
                 true, package-desktop.spec fails
                 if mac.entitlements or mac.entitlementsInherit is unset or not the
                 build-resources plist, package-desktop.spec fails (unset falls back to
                 the default plist that carries disable-library-validation)
                 if the plist contains com.apple.security.cs.disable-library-validation,
                 allow-dyld-environment-variables or allow-unsigned-executable-memory,
                 or lacks allow-jit, package-desktop.spec fails
                 if the files patterns admit build-resources/entitlements.mac.plist into
                 the app, package-desktop.spec's existing files table fails
       depends:  —

  t-11 Read fuse wire and signed entitlements
       files:    scripts/fuse-wire.ts (new), scripts/fuse-wire.spec.ts (new),
                 scripts/verify-packaged.ts, scripts/verify-packaged.spec.ts
       desc:     fuse-wire.ts (Node built-ins only, no new dependency) finds every
                 fuse sentinel in a binary and decodes each wire; fuseBinary(exe,
                 platform) names the file that holds it (on darwin the Electron
                 Framework binary, not the launcher). verify-packaged `mac --signed`
                 reads the signed app's entitlements with codesign and refuses
                 disable-library-validation.
       risk:     a reader that reports "off" when it read nothing (false green), or
                 reads only one slice of the universal binary
       covers:   c-8
       contract: if a synthetic buffer with the sentinel, version 1 and wire
                 '0011101' does not decode to exactly those seven states, fuse-wire.spec
                 fails
                 if a buffer with no sentinel, a truncated wire, or an unknown version
                 does not throw (never "all off"), fuse-wire.spec fails
                 if a buffer holding two wires (universal binary) that disagree does not
                 throw, or two that agree do not decode once, fuse-wire.spec fails
                 if reading the stock node_modules/electron binary (control, skipped
                 when absent) does not report RunAsNode and EnableNodeCliInspect-
                 Arguments ON, fuse-wire.spec fails (proves the reader sees real wires)
                 if fuseBinary for darwin does not point into Contents/Frameworks/
                 Electron Framework.framework, fuse-wire.spec fails
                 if verifyMac with signed:true accepts entitlements XML that contains
                 com.apple.security.cs.disable-library-validation, or rejects one with
                 only allow-jit, verify-packaged.spec fails (injected runner, fake
                 codesign output)
       depends:  —

  t-12 Wrap alerts key with safeStorage
       files:    src/desktop/alerts-key.ts, src/desktop/alerts-key.spec.ts,
                 src/desktop/main.ts, e2e/desktop/launch.ts
       desc:     loadOrCreateAlertsKey(keyFile, {safeStorage, platform}) with a
                 structural SafeStorage type (no electron import). Wrapped file format
                 is a non-base64 prefix plus the safeStorage ciphertext (base64), 0600.
                 Linux wraps only when getSelectedStorageBackend() is gnome_libsecret or
                 kwallet*; basic_text keeps the raw file. A raw file is migrated by
                 temp-write, fsync, decrypt round-trip check, then rename; any failure
                 keeps the raw file and returns its key. main.ts passes Electron's
                 safeStorage (loadKey already runs after whenReady). launchDesktop
                 adds --use-mock-keychain on darwin at the launch and relaunch sites
                 (not in electronArgs, which harness.e2e pins).
       risk:     a migration crash or keychain failure losing the only key (every
                 channel undecryptable), or the key regenerated over a wrapped file
       covers:   c-24, c-25
       contract: if a fresh load with a fake safeStorage (darwin, available) writes a
                 file that parseAlertsKey accepts (raw base64) or that does not start
                 with the wrapped prefix, alerts-key.spec fails
                 if linux with backend 'basic_text' wraps, or linux with
                 'gnome_libsecret' / 'kwallet5' keeps raw, or isEncryptionAvailable
                 false wraps, alerts-key.spec fails
                 if an existing raw file plus an available backend does not end
                 wrapped, or the returned key differs from the raw key's bytes,
                 alerts-key.spec 'migrates v0.1.5 raw key' fails
                 if encryptString throws, decryptString returns other bytes, or the
                 rename throws, and the raw file is not byte-identical afterwards, a
                 temp file remains, or the call does not return the raw key,
                 alerts-key.spec fails (one case per failure point)
                 if a wrapped file whose decryptString throws (keychain denied, other
                 machine) is rewritten, deleted, or replaced by a new key instead of
                 throwing AlertsKeyError naming the path, alerts-key.spec fails
                 if any thrown message contains the key's base64 or the ciphertext
                 (sentinel bytes), alerts-key.spec fails
                 if two concurrent loads over one raw file do not return the same key
                 and leave one valid file, alerts-key.spec fails
                 if the wrapped file is not mode 0600 on POSIX, alerts-key.spec fails
       depends:  —

  t-13 Add admin-only tag ruleset, enable protections
       files:    .github/rulesets/tags.json (new), scripts/rulesets.spec.ts
       desc:     tags.json: target tag, include refs/tags/v*, rules creation, update,
                 deletion and non_fast_forward, bypass only RepositoryRole 5 (admin).
                 The executor applies it with `gh api` and, in the same task, turns on
                 immutable releases and Dependabot vulnerability alerts, reading each
                 back. No secret is read or set.
       risk:     the ruleset file and the live repo drifting, or a bypass wider than
                 admin
       covers:   c-9, c-10, c-11
       contract: if tags.json is not target 'tag', enforcement 'active', include exactly
                 ['refs/tags/v*'], or lacks any of creation, update, deletion, rulesets.
                 spec 'tag ruleset' fails
                 if tags.json's bypass_actors is anything but exactly one
                 {actor_type:'RepositoryRole', actor_id:5}, rulesets.spec fails
                 if the branch-ruleset check-name comparison starts reading tags.json
                 (tag rulesets require no CI checks), rulesets.spec fails
                 executor observes, in the task log, `gh api` read-backs showing the
                 tag ruleset active, immutable releases enabled, and
                 vulnerability-alerts returning 204
       depends:  —

Wave 2
  t-14 Show clear-token and destination errors
       files:    src/routes/account/alerts/+page.svelte,
                 src/routes/account/alerts/page.svelte.spec.ts,
                 src/routes/account/alerts/page.server.spec.ts,
                 src/routes/account/alerts/alerts.e2e.ts
       desc:     The ntfy card gains a "Remove access token" checkbox (name
                 clear_token), shown only when a token is set. A refused destination
                 change shows inline in that card; the saved channel is unchanged.
       risk:     UI that lets the refusal pass unseen, or a clear control that removes
                 the channel instead of the token
       covers:   c-1, c-2
       contract: if the ntfy card renders a clear_token control while tokenSet is false,
                 or none while it is true, page.svelte.spec fails
                 if ?/save with clear_token on a saved ntfy channel does not leave the
                 channel present, enabled as before, with tokenSet false, page.server.
                 spec fails
                 if ?/save changing the SMTP host with a blank password does not return
                 fail(400) with that card's kind and a message naming the password, or
                 the stored config_enc blob changes, page.server.spec fails
                 if, in the browser, that refused save shows no message inside the SMTP
                 card, or a reload shows the new host, alerts.e2e fails
       depends:  t-2

  t-15 Wire session cookie into window and server
       files:    src/desktop/server.ts, src/desktop/server.spec.ts, src/desktop/window.ts,
                 src/desktop/window.spec.ts, src/desktop/main.ts,
                 e2e/desktop/guard.e2e.ts
       desc:     main creates the secret once per launch and passes it in memory (never
                 env or argv). startDesktopServer({handler, secret}) answers 403
                 'Forbidden' after the Host check when isAuthorized is false.
                 createMainWindow awaits session.cookies.set(cookieDetails) before any
                 loadURL. guard.e2e's raw-request controls attach the cookie read from
                 main, and the cookieless cases become 403. One task, six files: a split
                 would commit a server that 403s its own window.
       risk:     the window's first load racing the cookie (blank 403 window), and
                 raw local clients still reaching data or actions
       covers:   c-3
       contract: if startDesktopServer answers a request without the cookie with
                 anything but 403 'Forbidden' (same body as the Host 403: no oracle), or
                 calls the handler for it, or answers GET /health without the cookie
                 with other than the handler's response, server.spec fails
                 if startDesktopServer accepts a missing or empty secret, server.spec
                 fails (fail closed, no optional gate)
                 if createMainWindow calls loadURL before the cookies.set promise
                 resolves, on first open or on reopen after close, or a rejected
                 cookies.set leads to loadURL, window.spec fails (call-order log)
                 if main.ts puts the secret in process.env or any argv, the source ?raw
                 check in window.spec fails
                 if a raw request without the cookie to GET /, GET
                 /account/alerts/__data.json, an immutable asset, or POST ?/save with
                 the window's own Origin gets anything but 403, guard.e2e fails
                 if the window's own ?/save and ?/add form posts stop reaching their
                 actions, guard.e2e 'the window's own form posts reach their actions'
                 fails
                 if GET /health without the cookie is not 200, guard.e2e 'two
                 launches...' fails
       depends:  t-3, t-4, t-12

  t-16 Add CSP and frame-denial headers
       files:    vite.config.ts, src/hooks.server.ts, src/hooks.server.spec.ts,
                 e2e/security-headers.e2e.ts (new)
       desc:     kit.csp (mode 'auto': nonce on SSR, hash when prerendered) with
                 script-src 'self', img-src 'self' https://m.media-amazon.com,
                 frame-ancestors 'none', object-src 'none', base-uri 'self',
                 form-action 'self'; no style-src (Svelte and Vite inject styles).
                 build.assetsInlineLimit 0 so the favicon is not a data: URI that
                 img-src would block. The handle sets X-Frame-Options: DENY.
       risk:     a CSP that breaks the built or dev app (inline favicon, Kit's own
                 bootstrap), or one too loose to matter
       covers:   c-6, c-23
       contract: if the response to GET /, /account/alerts, /watches/<seeded id> or a
                 404 page lacks X-Frame-Options: DENY or a CSP with frame-ancestors
                 'none', security-headers.e2e fails
                 if any of those CSPs has a script-src containing 'unsafe-inline',
                 'unsafe-eval', a scheme or a host, or lacks a nonce/hash source, or an
                 img-src other than exactly 'self' https://m.media-amazon.com,
                 security-headers.e2e fails
                 if the built layout's rel=icon href starts with data:, security-
                 headers.e2e fails
                 if the handle drops X-Frame-Options on a non-page response it passes
                 through, or on Kit's error page, hooks.server.spec fails
       depends:  t-1, t-5

  t-17 Prove key migration on real backend
       files:    e2e/desktop/first-run.e2e.ts, e2e/desktop/seed-child.ts
       desc:     seed-child gains a command that writes a v0.1.5-style raw alerts.key
                 and an SMTP channel sealed under it. The e2e launches over that
                 userData and checks the file form against the real backend the app
                 reports (macOS mock keychain, Windows DPAPI, Linux CI basic_text).
       risk:     the real safeStorage API behaving unlike the fake (not ready, backend
                 names, Linux fallback) and stranding existing channels
       covers:   c-24, c-25
       contract: if, where safeStorage reports a real backend, alerts.key after the
                 first launch is still raw base64, or on Linux basic_text it is not
                 byte-identical to the seed, first-run.e2e 'v0.1.5 key migrates'
                 fails
                 if the seeded SMTP channel shows as unreadable, or its Send test does
                 not authenticate at the local test SMTP server with the seeded
                 password, first-run.e2e fails
                 if a second launch on the migrated file does not open the same channel,
                 first-run.e2e fails
       depends:  t-12

  t-18 Split signing toolchain into own package
       files:    signing/package.json (new), signing/pnpm-lock.yaml (new),
                 signing/sign-mac.ts (new), scripts/package-desktop.ts,
                 scripts/package-desktop.spec.ts
       desc:     signing/ is a standalone package pinning only electron-builder (exact,
                 same version as the root devDependency), installed with
                 `pnpm install --dir signing --ignore-workspace --frozen-lockfile
                 --ignore-scripts`. sign-mac.ts imports electron-builder from there and
                 calls package-desktop's packageDesktop with an injected build and a new
                 prepackaged option (sign, notarise, dmg + zip + latest-mac.yml from an
                 existing universal .app). The executor observes an unsigned local
                 prepackaged run produce the release file set before committing.
       risk:     the secret job loading project code or an unpinned toolchain; the
                 prepackaged path not producing the update feed
       covers:   c-26
       contract: if signing/package.json has any dependency besides electron-builder,
                 or electron-builder is not the root package.json's exact version, or
                 it has scripts or a postinstall, package-desktop.spec 'signing
                 toolchain' fails
                 if builderConfig with prepackaged set does not carry the prepackaged
                 .app path, keep the fuse and entitlement settings of t-10, or produce
                 the same mac targets, package-desktop.spec fails
                 if packageDesktop with prepackaged and sign:true reaches build() with
                 any of the five signing variables missing, package-desktop.spec fails
                 (the existing refusal holds on this path)
                 if the packaged app's files patterns admit signing/x, package-desktop.
                 spec's files table fails
                 if sign-mac.ts (source ?raw) imports anything from src/ other than via
                 scripts/package-desktop.ts, or any $app/* or #lib/*, package-desktop.
                 spec fails
       depends:  t-10

  t-19 Check live repo settings in CI
       files:    scripts/repo-settings.ts (new), scripts/repo-settings.spec.ts (new),
                 .github/workflows/settings.yml (new)
       desc:     checkRepoSettings(snapshot) is pure: the v* tag ruleset matches
                 .github/rulesets/tags.json, the release environment matches
                 .github/environments/release.json, immutable releases are on, and
                 vulnerability alerts are on. The CLI fetches with Node built-ins only
                 (no install) using REPO_SETTINGS_TOKEN (fine-grained, Administration:
                 read). settings.yml runs it daily, on push to main and on dispatch;
                 not a required check. Read ~/.claude/memory/reference_ci_supply_chain_
                 hardening.md first (CLAUDE.md CI hygiene). You (Michal) create the
                 token; I (Claude) stop and ask at that step.
       risk:     a check that passes when it could not read the settings (fail open)
       covers:   c-9, c-10, c-11
       contract: if a snapshot missing the tag ruleset, with it in 'evaluate'
                 enforcement, with an extra bypass actor, or with no creation rule
                 passes, repo-settings.spec fails
                 if a release environment without the v* tag policy, with
                 protected_branches true, or with custom_branch_policies false passes,
                 repo-settings.spec fails
                 if immutable releases {enabled:false} or vulnerability-alerts 404
                 passes, repo-settings.spec fails
                 if the CLI exits 0 with the token unset, on a 401/403/404/5xx from any
                 endpoint, or on a network error, repo-settings.spec fails (fake fetch)
                 if any output line contains the token value (sentinel), repo-settings.
                 spec fails
                 if settings.yml has a pnpm install step, a non-SHA action, or
                 permissions beyond contents: read, `pnpm ci:policy` / repo-settings.spec
                 fails
       depends:  t-13

Wave 3
  t-20 Add env-gated main-process e2e hook
       files:    src/desktop/e2e-hook.ts (new), src/desktop/e2e-hook.spec.ts (new),
                 src/desktop/main.ts
       desc:     Active only when PRICE_CHECK_E2E_CONTROL names an absolute dir at
                 launch. A file channel: the harness writes <dir>/<pid>/req-<n>.json,
                 main polls and writes res-<n>.json. A fixed command set (status: pid,
                 version, isPackaged, userData, platform, arch, origin; quit;
                 loginItemOff; updater status/checkNow/restart; appGet(path), where main
                 requests its own server with the cookie and returns status and body).
                 No eval, no listener. The variable stays in process.env so an updated
                 version inherits it.
       risk:     the hook re-opening the run-JS-under-the-signed-identity path the fuses
                 close, or being live in a normal launch
       covers:   c-27
       contract: if installE2eHook with the variable unset, empty or relative returns
                 anything but null, creates a timer, or touches the filesystem,
                 e2e-hook.spec fails (fake timers and fs)
                 if e2e-hook.ts (source ?raw) imports node:net, node:http, node:https,
                 node:dgram, node:child_process, node:vm or electron, or contains
                 eval, new Function or a dynamic import, e2e-hook.spec fails
                 if an unknown command, or a command with extra fields, gets anything
                 but an error response, e2e-hook.spec fails
                 if any response, for every command, contains the session secret
                 (sentinel injected through the appGet dependency), e2e-hook.spec fails
                 if a request addressed to another pid is answered, or stop() leaves a
                 timer running, e2e-hook.spec fails
                 if loadAdapterHandler's env replacement drops PRICE_CHECK_E2E_CONTROL,
                 e2e-hook.spec fails (pinned against serverEnv)
       depends:  t-15

  t-21 Split release signing job, clean p8
       files:    .github/workflows/release.yml, scripts/release-workflow.spec.ts,
                 scripts/workflow-policy.ts, scripts/workflow-policy.spec.ts
       desc:     build-macos becomes three jobs: package-macos (no environment, no
                 secrets: install, build, unsigned fused package, the .app tarred so
                 symlinks and modes survive upload), sign-macos (environment release,
                 the five secrets, checkout + signing toolchain install + node
                 signing/sign-mac.ts only; the step writing AuthKey.p8 opens with a
                 trap that removes it on EXIT), verify-macos (no secrets: install,
                 verify mac --signed, packaged smoke on the signed artefacts). The
                 policy check gains the secret-job and p8-cleanup rules. Read the CI
                 hardening memo first (CLAUDE.md).
       risk:     dependency or test code running where the Developer ID certificate
                 or notary key is readable; the p8 outliving its step
       covers:   c-15, c-26
       contract: if any job that references CSC_LINK, CSC_KEY_PASSWORD,
                 APPLE_API_KEY_P8_BASE64, APPLE_API_KEY_ID or APPLE_API_ISSUER also has
                 a step running `pnpm install` (other than --dir signing with
                 --frozen-lockfile and --ignore-scripts), pnpm build, build:desktop,
                 package:desktop, test, or test:e2e*, workflow-policy.spec fails, and
                 `pnpm ci:policy` fails on the edited release.yml
                 if any step that writes a .p8 does not set `trap 'rm -f ...' EXIT`
                 before the write, workflow-policy.spec fails (pinned with a fixture
                 workflow that writes one without it)
                 if environment: release is on any job but sign-macos, or sign-macos
                 does not need package-macos, or verify-macos references any secret,
                 release-workflow.spec fails
                 if package-macos uploads the .app other than as a tar, or sign-macos
                 does not download it, release-workflow.spec fails
                 if publish does not need verify-macos, build-windows and build-linux,
                 release-workflow.spec fails (an unverified signed build never ships)
       depends:  t-18, t-11

  t-22 Audit shipped dependency trees
       files:    .github/workflows/audit.yml, scripts/audit-shipped.ts (new),
                 scripts/audit-shipped.spec.ts (new)
       desc:     audit.yml runs `pnpm audit --json` over the full tree (no --prod) and
                 the signing lockfile, and audit-shipped.ts fails on a high or critical
                 advisory whose path starts at a production dependency, at electron,
                 @sveltejs/kit, svelte or @sveltejs/adapter-node, or anywhere in the
                 signing tree. Dev-only advisories are reported, not fatal. Fixtures are
                 cut from real pnpm audit --json output. Read the CI hardening memo
                 first (CLAUDE.md).
       risk:     a filter that drops a shipped advisory, or treats an audit that did
                 not run as clean
       covers:   c-11
       contract: if a fixture with a high advisory on @sveltejs/kit, on a transitive
                 dependency reached only through svelte, or on electron exits 0,
                 audit-shipped.spec fails
                 if a fixture whose only high advisory is reached only through esbuild
                 or vitest exits non-zero, audit-shipped.spec fails
                 if non-JSON output, an empty stdout, or a JSON error object exits 0,
                 audit-shipped.spec fails (fail closed)
                 if a moderate advisory on @sveltejs/kit exits non-zero, audit-shipped.
                 spec fails (threshold is high)
                 if audit.yml still passes --prod, or does not audit signing/, or runs
                 an install with scripts, the workflow assertions in audit-shipped.spec
                 fail
                 executor observes `node scripts/audit-shipped.ts` exit 0 on the
                 t-1-bumped tree, in the task log
       depends:  t-1, t-18

  t-23 Record CSP violations, prove dev works
       files:    e2e/desktop/launch.ts, e2e/desktop/harness.e2e.ts, e2e/dev-server.e2e.ts
       desc:     launchDesktop collects CSP violations from the Electron context's
                 console from the first page on; close() throws when any were seen,
                 so every desktop test gates on zero. The dev-server e2e also loads /
                 and /account/alerts under `vite dev` with the CSP in place and saves a
                 form.
       risk:     a collector that hears nothing (false zero), and a CSP that only
                 breaks under Vite's dev server
       covers:   c-23, c-19
       contract: if harness.e2e's control, which injects an inline <script> into the
                 window, does not make close() reject with a CSP message, harness.e2e
                 fails (proves the collector listens)
                 if any desktop e2e page logs a CSP violation, that test's close()
                 fails
                 if under `vite dev` GET / or /account/alerts is not 200 with the app
                 hydrated (a client-only element appears), logs a CSP violation, or a
                 same-origin form save fails, dev-server.e2e fails
       depends:  t-16, t-5, t-12, t-4

Wave 4
  t-24 Drive packaged app without the inspector
       files:    e2e/packaged/launch-packaged.ts, e2e/packaged/smoke.packaged.ts,
                 e2e/packaged/update.packaged.ts, scripts/ci-packaged.spec.ts
       desc:     launchPackaged spawns the exe itself with --remote-debugging-port=0,
                 reads DevToolsActivePort from userData and connects with
                 chromium.connectOverCDP for the window; main-process state goes
                 through the t-20 hook. Every former app.evaluate becomes a hook
                 command or a renderer evaluate. Raw requests that read pages use the
                 hook's appGet; cookieless ones assert 403. The smoke reads the fuse
                 wire of PRICE_CHECK_PACKAGED_EXE with fuse-wire.ts.
       risk:     the release artefacts only being testable with the inspector open;
                 packaged-only regressions from c-3 and c-8 going unseen
       covers:   c-22, c-8, c-3, c-27, c-19
       contract: if any file in e2e/packaged imports _electron, or any launch args or
                 spawn args there contain --inspect or --inspect-brk, ci-packaged.spec
                 fails
                 if the smoke's fuse test finds RunAsNode, NodeOptions, NodeCliInspect
                 or GrantFileProtocolExtraPrivileges on, or asar integrity or
                 OnlyLoadAppFromAsar off, in any slice, smoke.packaged fails
                 if the packaged app launched with --inspect=0 prints 'Debugger
                 listening' or opens a listener on an inspector port, smoke.packaged
                 fails (the fuse holds at run time)
                 if a cookieless GET / or /account/alerts/__data.json to the packaged
                 server is not 403, or the hook's appGet('/') is not 200 with the seeded
                 watch title, smoke.packaged fails (x64 slice included on darwin)
                 on Linux, if the app's processes listen on any TCP port besides the
                 server port and the DevToolsActivePort port, smoke.packaged fails
                 (the hook opened a listener)
                 if the relaunched updated version does not answer the hook (variable
                 lost at hand-over) or its appGet('/') lacks the watch title,
                 update.packaged fails
                 executor observes `pnpm test:e2e:packaged` green on macOS locally;
                 Windows and Linux green is read from the PR's CI, not claimed earlier
       depends:  t-20, t-10, t-11, t-15

Wave 5
  t-25 Re-audit and close SEC-01..17
       files:    .dross/security/state.toml (gitignored, never committed)
       desc:     Full unit, web e2e, desktop e2e and packaged suites plus pnpm lint and
                 pnpm check on the branch head, `pnpm dev` opened in a browser, then a
                 fresh /dross-secure run. Each SEC id is marked resolved or dismissed
                 (SEC-12 and the SEC-14 queue cap dismissed per locked decisions). A
                 new medium-or-higher finding is a blocker, not a note.
       risk:     declaring the phase done on the old audit while a fix opened a new
                 hole (the e2e hook, the renderer CDP port, the signing split)
       covers:   c-18, c-19
       contract: if the fresh /dross-secure report lists any new finding at medium or
                 higher, the task fails and opens a remediation task
                 if state.toml lacks any of SEC-01..SEC-17, or one is neither resolved
                 nor dismissed, the task fails
                 if `git ls-files .dross/security` prints anything, the task fails
                 executor observes every suite and `pnpm dev` in the task log; nothing
                 is reported green that was not run in this task
       depends:  t-1..t-24
```

## Coverage

| criterion | tasks (risk each owns) |
|---|---|
| c-1 | t-2 (secret leaves for new host), t-14 (refusal unseen in UI) |
| c-2 | t-2 (clear semantics), t-14 (clear control removes channel) |
| c-3 | t-3 (parsing/timing bypass), t-15 (first-load race, raw clients), t-24 (packaged-only regression) |
| c-4 | t-9 |
| c-5 | t-5 |
| c-6 | t-16 |
| c-7 | t-6 |
| c-8 | t-10 (config at defaults), t-11 (false-green reader), t-24 (released app wire) |
| c-9 | t-13 (ruleset and drift), t-19 (fail-open live check) |
| c-10 | t-13 (setting on), t-19 (live check) |
| c-11 | t-13 (alerts on), t-19 (live check), t-22 (filter drops shipped advisory) |
| c-12 | t-1 |
| c-13 | t-4 |
| c-14 | t-7 |
| c-15 | t-21 |
| c-16 | t-8 |
| c-17 | t-8 |
| c-18 | t-25 |
| c-19 | t-23 (dev under CSP), t-24 (packaged under fuses + gate), t-25 (final full run) |
| c-20 | t-2 |
| c-21 | t-9 |
| c-22 | t-24 |
| c-23 | t-16 (policy shape), t-23 (zero violations, collector proven live) |
| c-24 | t-12 (logic, fake backend), t-17 (real backend) |
| c-25 | t-12 (crash-safe migration), t-17 (channels still open and send) |
| c-26 | t-18 (toolchain isolation, prepackaged path), t-21 (job split + policy) |
| c-27 | t-20 (gate, no eval, no listener in source), t-24 (no listener at run time) |

27/27 covered.

## Judgment calls

- Gate in the desktop server wrapper (src/desktop/server.ts), not hooks.server.ts. Rejected: a Kit handle. Why: dev and `node build/index.js` stay ungated by construction (locked decision), and the secret never enters Kit's env.
- Gate wiring (server, window, main, guard e2e) is one 6-file task (t-15), over the 5-file split rule. Rejected: server then window in two commits. Why: the commit between them would 403 the app's own window and turn every desktop e2e red.
- Gate core is a pure module (t-3) with a required secret. Rejected: an optional `secret` parameter. Why: an optional security parameter fails open when someone forgets it.
- Only exact GET /health is exempt, HEAD included in the 403s. Rejected: GET+HEAD. Why: the criterion says "other than GET /health", and every extra exemption is another bypass to test.
- Check-now uses a conditional UPDATE claim on last_checked_at (t-9). Rejected: an in-memory per-watch lock or a new column. Why: SQLite makes the claim atomic, it survives a restart, a throwing fetch still starts the cooldown, and no migration is needed (the asarUnpack migration list stays as it is).
- Classifier skips the wall phrases on pages with product markers (t-6). Rejected: stripping known review/bullet containers. Why: a denylist misses the next user-content region (Q&A, descriptions). An allowlist of "this is a product page" holds wherever user text appears.
- Clearing a token together with a typed token is refused (t-2). Rejected: typed wins. Why: the input contradicts itself, and refusing is the outcome that cannot surprise the user.
- SMTP username compared exactly, host case-insensitively. Rejected: case-insensitive username. Why: a false refusal costs one retype, a false match can leak the password.
- Key scrub after the handler import, in loadAdapterHandler (t-4). Rejected: handing the key over a runtime bridge instead of env. Why: it is a smaller change, and t-4's e2e decrypt check catches it if Kit reads the key lazily.
- safeStorage wrap is a non-base64 prefix plus ciphertext, migrated with temp + fsync + round-trip check + rename (t-12). Rejected: writing a second file next to the raw one. Why: one file means the key can never be in two states. A downgrade to v0.1.5 then reads it as damaged; accepted because allowDowngrade is false.
- Fuse wire read by an in-repo parser (t-11). Rejected: adding @electron/fuses as a direct dependency. Why: no new supply-chain dependency. The control test against stock Electron proves the parser reads real wires. All slices of the universal binary are checked.
- Entitlements: allow-jit only (t-10). Rejected: keeping allow-unsigned-executable-memory. Why: it is the smaller surface. Risk: PR CI builds are unsigned, so hardened-runtime entitlement regressions surface only on a signed build. The first post-merge tag must be an rc (I (Claude) cut v0.2.0-rc.1 before any final).
- Signing toolchain is a standalone signing/ package with its own frozen lockfile (t-18). Rejected: `npm i electron-builder@x` in the job (no integrity pins) and a full root install with scripts off (loads the whole project tree next to the secrets). Why: c-26 says "only the pinned signing toolchain". Its lockfile is audited too (t-22).
- The .app crosses from package-macos to sign-macos as a tar (t-21). Rejected: plain upload-artifact of the bundle. Why: zip upload drops the symlinks and exec bits inside the framework bundles.
- Live settings check is a separate scheduled workflow, settings.yml (t-19). Rejected: a step in ci.yml's static job, or a required check. Why: the admin-read token stays out of every job that installs dependencies, settings drift is not caused by PRs, and no ruleset check names change. Blocker: You (Michal) must create the fine-grained token (Administration: read, this repo only). GITHUB_TOKEN cannot read immutable-releases or vulnerability-alerts.
- Packaged harness talks to main through a file channel with fixed commands (t-20). Rejected: a stdio/IPC channel or an eval-style hook. Why: it works the same on all three OSes, opens no listener, and never re-creates the arbitrary-JS primitive the fuses remove. appGet keeps the session secret inside main.
- Renderer CDP (--remote-debugging-port) stays honoured in packaged builds (locked "CDP to the renderer"). Rejected: refusing the switch unless an E2E variable is set. Why: setting either needs same-user control. t-25 must still record it explicitly if /dross-secure raises it.
- The packaged e2e is knowingly red from t-10 to t-24 (fuses off before the harness drops --inspect). Rejected: landing fuses in wave 4. Why: t-18's signing path needs t-10's entitlements and fuses in place. No task in waves 1-3 may cite the packaged suite as evidence.
- One owner per shared file per wave: main.ts goes t-12 → t-15 → t-20; e2e/desktop/launch.ts goes t-12 → t-23; harness.e2e.ts goes t-4 → t-23; package-desktop.ts goes t-10 → t-18. Rejected: parallel edits in one wave. Why: concurrent writers on one file is a merge failure mode this plan does not need.
