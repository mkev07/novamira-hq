# Novamira HQ (Headless Fork)

**Always-on Novamira HQ dashboard on a Linux server, reachable only over Tailscale.**

This fork of [Novamira HQ](https://github.com/use-novamira/novamira-hq) runs the
dashboard headless in a container (Dokploy on `vector-core`) instead of as a
desktop app, so your hosting accounts and WordPress sites are available from any
device on your tailnet without a Mac left running.

## How it works

```
 your device (on the tailnet)
        │  https://<server>.<tailnet>.ts.net:8788
        ▼
 tailscale serve --https=8788        host setting · tailnet-only · auto TLS
        │  http://127.0.0.1:18787
        ▼
 novamira-hq-tailnet (Dokploy compose)   Caddy relay, bound to loopback only
        │  http://app-…:8787 over dokploy-network
        ▼
 novamira-hq-web (Dokploy application)   this repo, built by Nixpacks
        │
        ▼
 volume novamira-hq-data → /data         config, history, credentials, site logins
```

- **The app** (`novamira-hq-web`) builds this repo with [`nixpacks.toml`](nixpacks.toml)
  (`npm run build`) and starts `node dist/index.js dashboard --listen 0.0.0.0:8787`.
  `0.0.0.0` is inside the container only; the port is **not** published on the host.
- **The relay** (`novamira-hq-tailnet`) exists because a Swarm service cannot
  publish a port on `127.0.0.1` alone. A standalone Caddy container on
  `dokploy-network` forwards `127.0.0.1:18787` → the app's service name, so it
  keeps working across redeploys.
- **Tailscale Serve** on the host terminates HTTPS with the node's `ts.net`
  certificate and only accepts tailnet peers. Nothing about the dashboard is
  reachable from the public internet.
- **The volume** keeps all state across redeploys (see environment below).
- **Deploys**: a GitHub push webhook on this repo calls Dokploy's deploy URL for
  the app, so every push to `main` rebuilds and restarts it.

The dashboard has **no login of its own**: anyone who can load the page gets its
mutation token and can use it. The private network is the only access control —
never publish port 8787 or attach a public domain without adding auth in front.

## Changes from upstream

| Area             | Upstream                                              | This fork                                                            |
| :--------------- | :---------------------------------------------------- | :------------------------------------------------------------------- |
| Bind address     | Loopback only (`127.0.0.1`, `::1`, `localhost`)       | Any address                                                          |
| Request checks   | Rejects non-loopback `Host`/`Origin`/`Sec-Fetch-Site` | Not checked (DNS-rebinding guard removed)                            |
| Post-bind check  | Exits if bound to a non-loopback address              | Removed                                                              |
| Credential store | OS keyring only; refuses to save without one          | Same, or owner-only files with `NOVAMIRA_HQ_CREDENTIALS=file`        |
| Runs as          | Desktop app                                           | Headless container                                                   |
| Connecting sites | Browser login on the same machine                     | Device code shown in the dashboard with `NOVAMIRA_HQ_DEVICE_LOGIN=1` |

Code patches, all marked `// ponytail:` for easy spotting during merges:

1. `src/web/server.ts` — `requireLoopbackHost()` is a no-op.
2. `src/web/server.ts` — `requireLoopbackRequest()` is a no-op.
3. `src/web/server.ts` — the post-bind loopback assertion is removed.
4. `src/main.ts`, `src/mcp/main.ts` — `NOVAMIRA_HQ_CREDENTIALS=file` selects
   upstream's existing `FileCredentialBackend` (`0600` files, not encrypted).
5. `src/integration/connect.ts`, `src/integration/spawn.ts`, `src/web/patch.ts`,
   `src/web/views/device-login.ts`, the two connect handlers — with
   `NOVAMIRA_HQ_DEVICE_LOGIN=1`, **Add site** runs `auth login --device` (a
   server has no browser for the loopback login) and opens a dialog with the
   code, a **Copy code & open approval page** button, the steps and a live
   expiry countdown. It closes itself when the login finishes. Only a page on
   the site being connected and a code-shaped value are ever displayed.
6. [`scripts/patch-site-cli.mjs`](scripts/patch-site-cli.mjs), run by the
   Nixpacks build — patches the installed `@novamira/cli` so device polling backs
   off on the Novamira plugin's `429 temporarily_unavailable` instead of failing
   the login with `auth_denied`. The build fails if the patch target moves.

Plus [`nixpacks.toml`](nixpacks.toml) for the Dokploy build.

## Deployment (Dokploy)

**1. Application** — Git source pointing at this repo, branch `main`, no domain.
Environment, plus a volume mount `novamira-hq-data` → `/data`:

| Variable                   | Value        | Holds                                  |
| :------------------------- | :----------- | :------------------------------------- |
| `NOVAMIRA_HQ_HOME`         | `/data/hq`   | HQ config, history, locks, credentials |
| `NOVAMIRA_HOME`            | `/data/site` | Site CLI profiles (WordPress tokens)   |
| `NOVAMIRA_HQ_CREDENTIALS`  | `file`       | Use the file credential backend        |
| `NOVAMIRA_HQ_DEVICE_LOGIN` | `1`          | Add site uses the device-code login    |

**2. Relay** — a compose service in the same project (replace the service name
with the app's Dokploy app name):

```yaml
services:
  tailnet-relay:
    image: caddy:2-alpine
    restart: unless-stopped
    command: caddy reverse-proxy --from :8787 --to <app-name>:8787
    ports:
      - "127.0.0.1:18787:8787"
    networks:
      - dokploy-network
networks:
  dokploy-network:
    external: true
```

**3. Tailscale Serve** — once, on the host:

```sh
sudo tailscale serve --bg --https=8788 http://127.0.0.1:18787
```

**4. Auto-deploy** — GitHub → Settings → Webhooks → `push` events to the app's
Dokploy deploy URL (`https://<dokploy>/api/deploy/<app refresh token>`).

## Updating from upstream

```sh
git fetch upstream
git merge upstream/main
bun install && bun run build && node --test test/*.test.mjs
git push origin main   # webhook redeploys
```

Five upstream tests are expected to fail because they assert the loopback
guards this fork removes (`requireLoopbackHost rejects…`, `a --listen naming a
routable host…`, `a non-loopback bind is refused…`, `the Host guard…`,
`the Origin and Sec-Fetch-Site guards`). Any other failure is real.

## Original README

Below is the upstream documentation. All features apply to this fork, with these
exceptions in a headless deployment:

- The desktop download and install steps do not apply; see
  [Deployment](#deployment-dokploy).
- "Runs on your computer" / "available only on your computer" becomes "runs on
  the server, available only on your tailnet".
- Hosting credentials are stored in owner-only files on the `/data` volume, not
  in an OS credential store.

---

**All your WordPress sites. One connection for your AI. A free and open source
desktop app.**

Novamira HQ brings your WordPress sites together in one local dashboard. Connect
your hosting accounts, prepare sites for Novamira, manage common hosting tasks,
and make your sites available to compatible AI agents through one connection.

[Download Novamira HQ](https://novamira.ai/hq) ·
[Documentation](https://novamira.ai/docs/hq)

## What you can do

- View hosting environments and manually added WordPress sites together.
- Install and configure Novamira on supported hosting environments.
- Create and restore backups, clear caches, inspect logs, and use other
  operations supported by each hosting provider.
- Save, review, and run content pushes between supported environments.
- Connect an MCP-compatible AI client once and use it across your sites.

Novamira HQ currently supports Kinsta, InstaWP, Pantheon, Pressable, WP Engine,
Rocket.net, Hostinger, Cloudways, Plesk, and xCloud. Available operations vary by provider.
Plesk accounts can list hosted domains. An active WP Toolkit adds WordPress
installation discovery, Novamira setup, WordPress backup and restore, and
directional copying between two selected WordPress installations. Plesk copying
requires an explicit database and/or WP Toolkit files scope; selected files and
a separate search-and-replace step are not supported. WP Toolkit excludes
WordPress configuration and server rewrite files from its default file copy.
xCloud accounts list WordPress sites with their staging sites, and support
backups, full-page cache purges, plugin and theme updates, access logs, and site
events. The xCloud API cannot install plugins, create or push staging sites, or
restore backups, so Novamira setup, pushes, and restores are not available
there; install the Novamira plugin yourself and connect the site by URL.

## How it works

1. Add a hosting account or a WordPress site.
2. Prepare and connect the sites you want to use.
3. Connect your AI to Novamira HQ from **Configure your AI**.

The dashboard and hosting integrations run on your computer. Your hosting and
WordPress connections remain local to your device.

## Privacy and safety

- Hosting credentials stay on your device and are stored using the operating
  system's credential store.
- Novamira HQ does not store WordPress site tokens in its own configuration.
- The dashboard is available only on your computer, not on the public network.
- Destructive provider operations such as deleting sites, environments,
  backups, domains, or DNS records are not exposed.
- Pushes and restores require an explicit review and confirmation. Creating a
  backup is always a separate action.

Read more in the [Novamira HQ documentation](https://novamira.ai/docs/hq).

## Development

Novamira HQ requires Node.js 22+ and uses Bun for development:

```sh
bun install
bun run build
node dist/index.js dashboard --open
```

Run the complete local check before submitting a change:

```sh
bun run check
```

## License

Novamira HQ is free and open source software licensed under
[AGPL-3.0-or-later](LICENSE). Copyright Ovation S.r.l.
