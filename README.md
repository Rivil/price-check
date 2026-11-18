# price-check

A desktop app that watches Amazon product prices for you and sends a notification when one drops to your target price. Every check runs on your own computer, from your own internet connection. There's no account to make and no service in the middle.

amazon.co.uk first. The shop integration is pluggable, so other shops can follow.

This tool fetches public Amazon product pages. Amazon's Conditions of Use restrict automated access, so you run it at your own risk.

## Install and use

Download the file for your computer from the [GitHub Releases page](https://github.com/Rivil/price-check/releases): the `.dmg` for macOS, the `.exe` for Windows or the `.AppImage` for Linux. The release's `.zip` and `.yml` files are for automatic updates, so you can ignore them.

### macOS

Open the `.dmg` and drag Price Check into Applications. There's one download for every Mac: it runs natively on both Apple silicon and Intel. The app is signed and notarised by Apple, so it opens normally.

### Windows

Run the installer (`.exe`). It installs price-check for your user account only, so it needs no administrator rights. The app isn't signed for Windows, so Microsoft Defender SmartScreen shows a warning the first time. Click **More info**, then **Run anyway**.

### Linux

The AppImage runs on 64-bit Intel and AMD PCs (x86_64).

1. Install FUSE 2, which AppImages need to start. On Ubuntu 22.04 that's `sudo apt install libfuse2`. On Ubuntu 24.04 and later the package is called `libfuse2t64`: `sudo apt install libfuse2t64`.
2. Make the file executable with `chmod +x price-check-*.AppImage`, then run it.
3. On Ubuntu 24.04 and later, AppArmor blocks the user namespaces that the app's security sandbox needs, so the app closes straight away. Allow them, then run the app again:

   ```sh
   sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
   ```

   That lasts until you restart. To keep the setting:

   ```sh
   echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf
   ```

   This relaxes an Ubuntu-wide restriction, and the app keeps its own sandbox switched on.

### Add your first watch

1. Copy the link of a product page on amazon.co.uk.
2. In price-check, paste the link and set your **target price**.
3. That's it. The app checks the price every few hours and notifies you when it reaches your target.

### Updates

The app downloads new releases in the background and tells you when one is ready. Choose **Restart to update** from its tray or menu bar icon, or let it install the next time you quit. Closing the window keeps it running in the tray or menu bar, so your prices keep getting checked.

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
