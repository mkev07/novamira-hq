// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** WordPress discovery at the root of each cPanel domain. */

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import type { HostingEnvironment, HostingSite } from "../types.js";
import type { CpanelApi, ToolkitInstallation } from "./cpanel-uapi.js";

const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

export interface CpanelWordPress {
  readonly domain: string;
  /** Relative to the account's home directory, e.g. `public_html`. */
  readonly documentRoot: string;
  /**
   * The site's own origin with a trailing slash, e.g. `https://www.example.com/`.
   * Without WP Toolkit this is `https://<domain>/`.
   */
  readonly siteUrl: string;
  readonly version?: string;
  readonly toolkitId?: number;
  readonly multisite?: boolean;
  /** WP Toolkit's liveness flag; unknown without WP Toolkit. */
  readonly alive?: boolean;
}

interface DomainRoot {
  readonly domain: string;
  /** Relative to the account's home directory. */
  readonly documentRoot: string;
  /** Absolute path as cPanel reports it, without trailing slashes. */
  readonly absoluteRoot: string;
}

function validDomain(value: string): string | undefined {
  const lower = value.toLowerCase();
  return DOMAIN.test(lower) ? lower : undefined;
}

/** A domain id typed by the user; provider data goes through `validDomain`. */
export function domainName(value: string): string {
  const domain = validDomain(value);
  if (domain === undefined)
    throw new CliError("usage_error", "Select a cPanel domain.");
  return domain;
}

export function domainFromEnvId(envId: string): string {
  if (!envId.startsWith("domain:"))
    throw new CliError("usage_error", "Select a cPanel WordPress site.");
  return domainName(envId.slice("domain:".length));
}

/** `undefined` when the reported document root cannot be trusted. */
function documentRootOf(
  documentRoot: unknown,
  homedir: unknown,
): { readonly relative: string; readonly absolute: string } | undefined {
  if (
    typeof documentRoot !== "string" ||
    typeof homedir !== "string" ||
    !documentRoot.startsWith(`${homedir}/`) ||
    documentRoot.includes("\0")
  )
    return undefined;
  const absolute = documentRoot.replace(/\/+$/, "");
  const relative = absolute.slice(homedir.length + 1);
  if (
    relative === "" ||
    absolute.split("/").some((segment) => segment === ".." || segment === ".")
  )
    return undefined;
  return { relative, absolute };
}

/**
 * One entry per document root, attributed to the main domain first, then the
 * addon domains, then the sub-domains, in the order cPanel lists them. An
 * entry cPanel describes with an unusable name (a wildcard sub-domain) or
 * document root is left out rather than failing the whole inventory.
 */
async function domainRoots(
  api: CpanelApi,
  signal?: AbortSignal,
): Promise<DomainRoot[]> {
  const data = asRecord(
    await api.uapi(
      "DomainInfo",
      "domains_data",
      { format: "hash" },
      { signal },
    ),
  );
  if (!data)
    throw new CliError(
      "provider_error",
      "cPanel returned an invalid domain list.",
    );
  const entries: unknown[] = [
    data.main_domain,
    ...(Array.isArray(data.addon_domains)
      ? (data.addon_domains as unknown[])
      : []),
    ...(Array.isArray(data.sub_domains) ? (data.sub_domains as unknown[]) : []),
  ];
  const seen = new Set<string>();
  const roots: DomainRoot[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record || typeof record.domain !== "string") continue;
    const domain = validDomain(record.domain);
    const root = documentRootOf(record.documentroot, record.homedir);
    if (domain === undefined || root === undefined) continue;
    if (seen.has(root.relative)) continue;
    seen.add(root.relative);
    roots.push({
      domain,
      documentRoot: root.relative,
      absoluteRoot: root.absolute,
    });
  }
  return roots;
}

async function fileNames(
  api: CpanelApi,
  dir: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const rows = await api.uapi(
    "Fileman",
    "list_files",
    { dir, types: "file" },
    { signal },
  );
  if (!Array.isArray(rows))
    throw new CliError(
      "provider_error",
      "cPanel returned an invalid file list.",
    );
  return new Set(
    rows
      .map((row) => asRecord(row)?.file)
      .filter((name): name is string => typeof name === "string"),
  );
}

async function wordpressVersion(
  api: CpanelApi,
  root: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const content = asRecord(
      await api.uapi(
        "Fileman",
        "get_file_content",
        { dir: `${root}/wp-includes`, file: "version.php" },
        { signal },
      ),
    )?.content;
    const match =
      typeof content === "string"
        ? /\$wp_version\s*=\s*'([0-9][0-9A-Za-z.-]{0,40})'/.exec(content)
        : null;
    return match?.[1];
  } catch (error) {
    if (error instanceof CliError && error.code === "provider_error")
      return undefined;
    throw error;
  }
}

/**
 * Novamira detection for an account without WP Toolkit, read from its files.
 * This is an internal helper for the setup paths, not a plugin inventory:
 * with no `novamira` directory the answer is an empty list; with one it is a
 * single row. Activation cannot be observed from files, so the row's status is
 * `unknown`, and `version` is present only when the plugin header could be
 * read. A plugin directory that cannot be listed is an error, never an empty
 * answer.
 */
export async function novamiraPluginRowsFromFiles(
  api: CpanelApi,
  documentRoot: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const rows = await api.uapi(
    "Fileman",
    "list_files",
    { dir: `${documentRoot}/wp-content/plugins`, types: "dir" },
    { signal },
  );
  if (!Array.isArray(rows))
    throw new CliError(
      "provider_error",
      "cPanel returned an invalid file list.",
    );
  const present = rows.some((row) => {
    const entry = asRecord(row);
    return entry?.file === "novamira" && entry.type !== "file";
  });
  if (!present) return [];
  let version: string | undefined;
  try {
    const content = asRecord(
      await api.uapi(
        "Fileman",
        "get_file_content",
        {
          dir: `${documentRoot}/wp-content/plugins/novamira`,
          file: "novamira.php",
        },
        { signal },
      ),
    )?.content;
    version =
      typeof content === "string"
        ? /^[ \t*]*Version:[ \t]*([0-9][0-9A-Za-z.+-]{0,40})[ \t]*\r?$/m.exec(
            content,
          )?.[1]
        : undefined;
  } catch (error) {
    if (!(error instanceof CliError && error.code === "provider_error"))
      throw error;
  }
  return [
    {
      name: "novamira",
      status: "unknown",
      ...(version === undefined ? {} : { version }),
    },
  ];
}

export async function discoverWordPress(
  api: CpanelApi,
  signal?: AbortSignal,
): Promise<{
  readonly toolkit: boolean;
  readonly sites: readonly CpanelWordPress[];
}> {
  const roots = await domainRoots(api, signal);
  const installations = await api.toolkitInstallations(signal);
  if (installations !== undefined) {
    const candidates: { item: ToolkitInstallation; url: URL }[] = [];
    for (const item of installations) {
      let url: URL;
      try {
        url = new URL(item.url);
      } catch {
        continue;
      }
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.pathname.replace(/\/+$/, "") !== "" ||
        url.search ||
        url.hash
      )
        continue;
      candidates.push({ item, url });
    }
    // Hosts first (exact, then without a leading `www.`); an installation
    // only falls back to its path for a domain no host has claimed.
    const claimed = new Map<DomainRoot, (typeof candidates)[number]>();
    const byHost = new Set<(typeof candidates)[number]>();
    for (const candidate of candidates) {
      const host = candidate.url.hostname.toLowerCase();
      const bare = host.replace(/^www\./, "");
      const root =
        roots.find((entry) => entry.domain === host) ??
        roots.find((entry) => entry.domain === bare);
      if (!root) continue;
      byHost.add(candidate);
      if (!claimed.has(root)) claimed.set(root, candidate);
    }
    for (const candidate of candidates) {
      if (byHost.has(candidate)) continue;
      const installPath = candidate.item.path.replace(/\/+$/, "");
      const root = roots.find(
        (entry) => entry.absoluteRoot === installPath && !claimed.has(entry),
      );
      if (root) claimed.set(root, candidate);
    }
    const sites: CpanelWordPress[] = [];
    for (const root of roots) {
      const candidate = claimed.get(root);
      if (!candidate) continue;
      sites.push({
        domain: root.domain,
        documentRoot: root.documentRoot,
        siteUrl: `${candidate.url.origin}/`,
        version: candidate.item.version,
        toolkitId: candidate.item.id,
        multisite: candidate.item.multisite,
        alive: candidate.item.alive,
      });
    }
    return { toolkit: true, sites };
  }
  const sites: CpanelWordPress[] = [];
  for (const root of roots) {
    signal?.throwIfAborted();
    let names: Set<string>;
    try {
      names = await fileNames(api, root.documentRoot, signal);
    } catch (error) {
      // A root cPanel cannot list is that domain's problem; network,
      // credential, timeout and abort failures still end the whole listing.
      if (error instanceof CliError && error.code === "provider_error")
        continue;
      throw error;
    }
    if (!names.has("wp-config.php")) continue;
    const version = await wordpressVersion(api, root.documentRoot, signal);
    sites.push({
      domain: root.domain,
      documentRoot: root.documentRoot,
      siteUrl: `https://${root.domain}/`,
      ...(version === undefined ? {} : { version }),
    });
  }
  return { toolkit: false, sites };
}

export function cpanelEnvironment(entry: CpanelWordPress): HostingEnvironment {
  return {
    id: `domain:${entry.domain}`,
    name: "live",
    displayName: "Live",
    isBlocked: entry.alive === false,
    isPremium: false,
    ...(entry.version === undefined ? {} : { wordpressVersion: entry.version }),
    primaryDomain: entry.siteUrl,
  };
}

export function cpanelSite(
  entry: CpanelWordPress,
  withEnvironments: boolean,
): HostingSite {
  return {
    id: entry.domain,
    name: entry.domain,
    displayName: entry.domain,
    status: "unknown",
    primaryDomain: entry.domain,
    ...(withEnvironments ? { environments: [cpanelEnvironment(entry)] } : {}),
  };
}
