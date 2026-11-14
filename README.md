# price-check

A desktop app that watches Amazon product prices for you and sends a notification when one drops to your target price. Every check runs on your own computer, from your own internet connection. There's no account to make and no service in the middle.

amazon.co.uk first. The shop integration is pluggable, so other shops can follow.

This tool fetches public Amazon product pages. Amazon's Conditions of Use restrict automated access, so you run it at your own risk.

## Install and use

> **Not released yet.** The first desktop release is still being built. These steps describe how it will work once it's published.

Download the file for your computer from the [GitHub Releases page](https://github.com/Rivil/price-check/releases), then:

- **macOS:** open the `.dmg` and drag price-check into Applications. It is signed and notarised, so it opens normally.
- **Windows:** run the installer (`.exe`). The app isn't signed for Windows, so Microsoft Defender SmartScreen shows a warning the first time. Click **More info**, then **Run anyway**.
- **Linux:** download the `.AppImage`, make it executable (`chmod +x price-check-*.AppImage`), and run it.

The app updates itself when a new release comes out. Closing the window keeps it running in the tray or menu bar, so your prices keep getting checked.

### Add your first watch

1. Copy the link of a product page on amazon.co.uk.
2. In price-check, paste the link and set your **target price**.
3. That's it. The app checks the price every few hours and notifies you when it reaches your target.

## Development

Built with SvelteKit (Svelte 5, adapter-node), Drizzle ORM on SQLite (libsql), TypeScript and pnpm. Electron packaging is in progress. Everything runs with the native Node toolchain.

```sh
pnpm install
pnpm exec playwright install chromium   # browser for component and e2e tests
cp .env.example .env                    # then set ALERTS_ENCRYPTION_KEY (openssl rand -base64 32)
pnpm db:migrate
pnpm dev                                # http://localhost:5173, no sign-in
```

| Task          | Command                |
| ------------- | ---------------------- |
| Unit tests    | `pnpm test:unit --run` |
| e2e tests     | `pnpm test:e2e`        |
| Typecheck     | `pnpm check`           |
| Lint          | `pnpm lint`            |
| Format        | `pnpm format`          |
| Migrate       | `pnpm db:migrate`      |
| New migration | `pnpm db:generate`     |
| CI policy     | `pnpm ci:policy`       |

Tests never hit live shop sites: shop adapters are tested against recorded HTML fixtures.

Every pull request runs lint, typecheck, the workflow policy check, a gitleaks secret scan, and the unit and e2e tests on Linux, macOS and Windows.

## Licence

[GNU Affero General Public License v3.0 or later](LICENSE). You can use, modify and share this program. If you distribute a modified version, or run one that other people use over a network, you must make its source code available to them under the same licence.

This program comes with no warranty. See the licence for details.
