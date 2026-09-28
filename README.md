# Novamira HQ (Headless Fork)

**Always-on web dashboard for Novamira, designed for Tailscale/server deployment.**

This fork of [Novamira HQ](https://github.com/use-novamira/novamira-hq) removes the desktop-only loopback restrictions to enable headless deployment on Linux servers (e.g., Dokploy on vector-core). Access your WordPress sites and AI connections from anywhere on your tailnet without needing a local Mac/desktop running.

## Changes from Upstream

| Area                   | Original (use-novamira/novamira-hq)                  | This Fork (mkev07/novamira-hq)                                |
| :--------------------- | :--------------------------------------------------- | :------------------------------------------------------------ |
| **Bind Address**       | Loopback only (`127.0.0.1`, `::1`, `localhost`)      | Any address (`0.0.0.0`, Tailscale IP, etc.)                   |
| **Request Validation** | Rejects non-loopback `Host`/`Origin` headers         | Accepts any valid host header                                 |
| **Post-Bind Check**    | Shuts down if bound to non-loopback                  | No restriction                                                |
| **Credential Store**   | macOS Keychain / Windows CredMan / Linux secret-tool | Same, or owner-only files with `NOVAMIRA_HQ_CREDENTIALS=file` |
| **Deployment Target**  | Desktop app (macOS/Windows/Linux GUI)                | Headless server (Dokploy, Docker, systemd)                    |
| **Access Method**      | Local browser only                                   | Any device on network/Tailscale                               |
| **Upstream Sync**      | N/A                                                  | Merge/rebase from `upstream/main` supported                   |

### Technical Details

Three surgical patches in `src/web/server.ts`:

1.  `requireLoopbackHost()` — returns immediately instead of throwing
2.  `requireLoopbackRequest()` — skips Host/Origin/sec-fetch-site validation
3.  Post-bind loopback assertion — removed entirely

`NOVAMIRA_HQ_CREDENTIALS=file` (read in `src/main.ts` and `src/mcp/main.ts`) selects upstream's existing `FileCredentialBackend` (owner-only `0600` files, not encrypted). Without it, HQ refuses to save credentials when no OS keyring exists.

All patches are marked with `// ponytail:` comments for easy identification during upstream merges.

### Server environment

Mount one persistent volume at `/data` and set:

| Variable                  | Value        | Holds                                  |
| :------------------------ | :----------- | :------------------------------------- |
| `NOVAMIRA_HQ_HOME`        | `/data/hq`   | HQ config, history, locks, credentials |
| `NOVAMIRA_HOME`           | `/data/site` | Site CLI profiles (WordPress tokens)   |
| `NOVAMIRA_HQ_CREDENTIALS` | `file`       | Use the file credential backend        |

The dashboard has no login of its own: anyone who can load the page can use it. Only expose it on a private network (e.g. `tailscale serve`), never publicly.

## Original README

Below is the original Novamira HQ documentation. All features apply to this fork except the desktop-specific installation instructions — use `node dist/index.js dashboard --listen 0.0.0.0:8787` (or your Tailscale IP) instead.

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
Rocket.net, Hostinger, and Cloudways. Available operations vary by provider.

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
