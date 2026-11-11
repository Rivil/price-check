# price-check-app

Tracks prices of watched Amazon products over time and alerts you when one drops below your target price.

amazon.co.uk first; the shop integration is pluggable so other shops can follow.

**Status:** being turned into a cross-platform desktop app (Electron) that runs on your own machine, so checks go out from your own connection. Until that lands, it runs as a self-hosted server (below).

This tool fetches public Amazon product pages. Amazon's Conditions of Use restrict automated access; you run it at your own risk.

## Stack

SvelteKit 3 (adapter-node) · Drizzle ORM on SQLite (libsql) · better-auth · pnpm · Docker.

## Development

Everything runs in Docker (`compose.yaml` is the dev stack).

```sh
cp .env.example .env          # then set BETTER_AUTH_SECRET (32+ random chars)
                              # and ALERTS_ENCRYPTION_KEY (openssl rand -base64 32)
docker compose build app
docker compose run --rm app pnpm db:migrate
docker compose up app         # http://localhost:5173
```

| Task          | Command                                                     |
| ------------- | ----------------------------------------------------------- |
| Test          | `docker compose run --rm app pnpm test`                     |
| Typecheck     | `docker compose run --rm app pnpm check`                    |
| Lint          | `docker compose run --rm app pnpm lint`                     |
| Format        | `docker compose run --rm app pnpm format`                   |
| Migrate       | `docker compose run --rm app pnpm db:migrate`               |
| New migration | `docker compose run --rm app pnpm db:generate`              |
| Prod image    | `docker build --target runtime -t price-check-app:latest .` |

Tests never hit live shop sites: shop adapters are tested against recorded HTML fixtures.

## Production

The runtime image serves on port 3000 and keeps its SQLite database in the `/data` volume. Migrations run automatically when the server starts.

Run it behind a TLS reverse proxy (Caddy, Traefik, nginx) that keeps the `Host` header and sets `X-Forwarded-Proto`, and set `ORIGIN` to the public `https://` URL. adapter-node 6 takes the request origin from those headers (defaulting to https), so plain HTTP straight to port 3000 fails SvelteKit's CSRF check on every form POST, including sign-in.

Environment: `BETTER_AUTH_SECRET`, `ALERTS_ENCRYPTION_KEY`, `ORIGIN=https://<public name>`, optional `CHECK_INTERVAL_HOURS`. Behind a single trusted proxy that drops client-supplied `X-Forwarded-For`, also set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` so failed sign-ins are rate-limited per real client address. Set those two only behind such a proxy: exposed directly, they would let a client choose its own address.

- `ALERTS_ENCRYPTION_KEY` — base64 of 32 random bytes (`openssl rand -base64 32`) — encrypts saved alert channel credentials. The server refuses to start without it. Losing the key only means re-entering channel credentials on Account → Alerts.
- `GET /health` is available for probing. It needs no sign-in and answers 200 `{"status":"ok"}` when the database is readable, otherwise 503 `{"status":"unavailable"}`.

First admin, once the container is up:

```sh
docker exec -it <container> node src/lib/server/cli/admin-create.ts   # prompts for email, name, password
```

`scripts/image-smoke.sh` (run on the host) builds the image, checks it refuses to start without `ALERTS_ENCRYPTION_KEY`, boots it on an empty volume, checks `/health`, creates an admin, signs in and checks the watchlist loads.

After changing dependencies, run `docker compose run --rm app pnpm install` (deps live in a Docker volume, not the host `node_modules`).

## Licence

[GNU Affero General Public License v3.0 or later](LICENSE). You can use, modify and share this program. If you distribute a modified version, or run one that other people use over a network, you must make its source code available to them under the same licence.

This program comes with no warranty. See the licence for details.
