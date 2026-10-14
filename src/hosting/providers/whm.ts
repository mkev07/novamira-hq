// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WHM server adapter over WHM API 1 with an API token of root (every account
 * on the server) or of a reseller (the accounts it owns).
 */

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import {
  type ActionRequest,
  type ListSitesOptions,
  type ProviderClient,
  type ReadRequest,
  unsupportedActionRequest,
  unsupportedReadRequest,
} from "../client.js";
import type {
  ProviderClientContext,
  ProviderClientFactory,
} from "../factory.js";
import type {
  ActionResult,
  HostingEnvironment,
  HostingSite,
  OperationStatus,
  ProviderCapability,
  ProviderValidation,
} from "../types.js";
import { CPANEL_CAPABILITIES, type CpanelClientOptions } from "./cpanel.js";
import {
  backupStartedResult,
  CompletedActions,
  defaultSleep,
  dispatchSetup,
} from "./cpanel-client-support.js";
import {
  createAccountBackup,
  listHomeBackups,
  readErrorLog,
  startAccountBackup,
} from "./cpanel-backups.js";
import {
  cpanelEnvironment,
  cpanelSite,
  type CpanelWordPress,
  discoverWordPress,
  domainName,
} from "./cpanel-sites.js";
import { type CpanelApi, CPANEL_USERNAME } from "./cpanel-uapi.js";
import {
  type AccountApiOptions,
  accountGone,
  createAccountApi,
  createWhmApi,
  createWhmToolkit,
  permissionDenied,
  type WhmApi,
  type WhmToolkit,
} from "./whm-api.js";
import { sessionUploads } from "./whm-session.js";

const PROVIDER = "whm" as const;
/** How many accounts one listing discovers at the same time. */
const LISTING_CONCURRENCY = 4;

/**
 * The cPanel table with only the `sites.list` note reworded: a WHM server
 * reaches every cPanel account, so the two cannot drift apart.
 */
export const WHM_CAPABILITIES: readonly ProviderCapability[] =
  CPANEL_CAPABILITIES.map((capability) =>
    capability.name === "sites.list"
      ? {
          ...capability,
          notes: "WordPress at the root of each domain of every cPanel account",
        }
      : capability,
  );

/** `<user>:<domain>`: the id of a WHM site and of its one environment. */
export function whmSiteId(user: string, domain: string): string {
  return `${user}:${domain}`;
}

export function parseWhmId(id: string): {
  readonly user: string;
  readonly domain: string;
} {
  const split = id.indexOf(":");
  const user = split < 0 ? "" : id.slice(0, split);
  try {
    if (CPANEL_USERNAME.test(user))
      return { user, domain: domainName(id.slice(split + 1)) };
  } catch {
    // Reported below for the whole id, not for its domain alone.
  }
  throw new CliError(
    "usage_error",
    "Select a WHM WordPress site as <account>:<domain>.",
  );
}

function noWordPress(): CliError {
  return new CliError(
    "not_found",
    "No WordPress was found at the root of this domain.",
  );
}

function whmEnvironment(
  user: string,
  entry: CpanelWordPress,
): HostingEnvironment {
  return {
    ...cpanelEnvironment(entry),
    id: whmSiteId(user, entry.domain),
  };
}

function whmSite(
  user: string,
  entry: CpanelWordPress,
  withEnvironments: boolean,
): HostingSite {
  return {
    ...cpanelSite(entry, false),
    id: whmSiteId(user, entry.domain),
    displayName: `${entry.domain} (${user})`,
    ...(withEnvironments
      ? { environments: [whmEnvironment(user, entry)] }
      : {}),
  };
}

class WhmClient implements ProviderClient {
  readonly provider = PROVIDER;
  readonly #context: ProviderClientContext;
  readonly #whm: WhmApi;
  readonly #configured: boolean;
  readonly #credentialSource: string;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #transferFetch: typeof fetch;
  readonly #completed = new CompletedActions(PROVIDER);

  constructor(
    context: ProviderClientContext,
    options: CpanelClientOptions = {},
  ) {
    this.#context = context;
    this.#whm = createWhmApi(context);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#transferFetch = context.transferFetch ?? globalThis.fetch;
    this.#configured = context.profile.apiBaseUrl !== undefined;
    this.#credentialSource = context.credentialSource;
  }

  #requireConfigured(): Promise<void> {
    return this.#configured
      ? Promise.resolve()
      : Promise.reject(
          new CliError(
            "config_error",
            "Set this WHM profile's api_base_url to the HTTPS WHM address before connecting.",
          ),
        );
  }

  async validate(): Promise<ProviderValidation> {
    await this.#requireConfigured();
    // Listing accounts is the one privilege every operation needs; WHM answers
    // root with every account and a reseller with the accounts it owns.
    await this.#listaccts({ want: "user" });
    return {
      provider: PROVIDER,
      status: "active",
      companyId: this.#whm.user,
      credential: this.#credentialSource,
    };
  }

  /** `listaccts`, naming the privilege when the user's do not allow it. */
  async #listaccts(
    params: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.#whm.call("listaccts", params, { signal });
    } catch (error) {
      if (permissionDenied(error))
        throw new CliError(
          "credential_invalid",
          "This WHM user cannot list accounts. Ask the server owner to give it the list-accts privilege (WHM » Edit Reseller Nameservers and Privileges).",
        );
      throw error;
    }
  }

  /**
   * The cPanel accounts HQ may work in: valid user names that are not
   * suspended, sorted by user so every listing has one order.
   */
  async #accounts(signal?: AbortSignal): Promise<readonly string[]> {
    const rows = asRecord(
      await this.#listaccts({ want: "user,domain,suspended" }, signal),
    )?.acct;
    if (!Array.isArray(rows))
      throw new CliError(
        "provider_error",
        "WHM returned an invalid account list.",
      );
    const users = new Set<string>();
    for (const row of rows) {
      const account = asRecord(row);
      const user = account?.user;
      const suspended = account?.suspended;
      if (
        typeof user === "string" &&
        CPANEL_USERNAME.test(user) &&
        (suspended === 0 || suspended === "0" || suspended === false)
      )
        users.add(user);
    }
    return [...users].sort();
  }

  /**
   * One account's WordPress, found like cPanel finds it. Each public operation
   * builds its own toolkit and account APIs, so the WP Toolkit list, the
   * feature answer and the home directory are each read once per operation and
   * never outlive it: HQ's site cache decides how fresh an inventory is.
   */
  async #site(
    id: string,
    signal?: AbortSignal,
    options: AccountApiOptions = {},
  ): Promise<{
    readonly user: string;
    readonly api: CpanelApi;
    readonly site: CpanelWordPress;
  }> {
    await this.#requireConfigured();
    const { user, domain } = parseWhmId(id);
    if (!(await this.#accounts(signal)).includes(user)) throw accountGone(user);
    const api = createAccountApi(
      this.#whm,
      createWhmToolkit(this.#context, this.#whm),
      user,
      options,
    );
    const site = (await discoverWordPress(api, signal)).sites.find(
      (entry) => entry.domain === domain,
    );
    if (!site) throw noWordPress();
    return { user, api, site };
  }

  async listSites(options: ListSitesOptions = {}): Promise<HostingSite[]> {
    await this.#requireConfigured();
    const shared = createWhmToolkit(this.#context, this.#whm);
    // The WP Toolkit list belongs to the server, not to the account whose
    // discovery happens to ask for it: when it fails, no account's answer can
    // be trusted, so that error ends the listing instead of skipping accounts.
    // Once it has failed it is not asked for again in this listing.
    let serverFailure: { readonly error: unknown } | undefined;
    const toolkit: WhmToolkit = {
      wpt: shared.wpt,
      async installations(signal) {
        if (serverFailure !== undefined) throw serverFailure.error;
        try {
          return await shared.installations(signal);
        } catch (error) {
          serverFailure ??= { error };
          throw error;
        }
      },
    };
    const users = await this.#accounts();
    const found: HostingSite[][] = users.map(() => []);
    let fatal: { readonly error: unknown } | undefined;
    let next = 0;
    const discover = async (user: string): Promise<HostingSite[]> => {
      const api = createAccountApi(this.#whm, toolkit, user);
      try {
        return (await discoverWordPress(api)).sites.map((entry) =>
          whmSite(user, entry, options.includeEnvironments === true),
        );
      } catch (error) {
        // An account that went away or cannot be read is left out, as cPanel
        // leaves out an unreadable domain; the server-wide list, network,
        // credential, timeout and abort failures still end the whole listing.
        if (
          error !== serverFailure?.error &&
          error instanceof CliError &&
          (error.code === "provider_error" || error.code === "not_found")
        )
          return [];
        throw error;
      }
    };
    // A small pool: at most LISTING_CONCURRENCY accounts are discovered at
    // once, each result kept at its account's index so the order is the
    // sorted one. After the first fatal failure no new account starts, and the
    // listing waits for the ones in flight before it fails.
    const worker = async (): Promise<void> => {
      while (fatal === undefined && next < users.length) {
        const index = next++;
        const user = users[index];
        if (user === undefined) break;
        try {
          found[index] = await discover(user);
        } catch (error) {
          fatal ??= { error };
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(LISTING_CONCURRENCY, users.length) },
        worker,
      ),
    );
    if (fatal !== undefined) throw fatal.error;
    return found.flat();
  }

  async getSite(siteId: string): Promise<HostingSite> {
    const { user, site } = await this.#site(siteId);
    return whmSite(user, site, true);
  }

  async listEnvironments(siteId: string): Promise<HostingEnvironment[]> {
    const { user, site } = await this.#site(siteId);
    return [whmEnvironment(user, site)];
  }

  /**
   * Runs one per-site operation on its own account API, released afterwards
   * whatever the outcome: the temporary cPanel session of the installer path
   * must never outlive the operation that opened it. Only setup passes
   * `options.uploads`; every other operation has no way to open a session.
   */
  async #withSite<T>(
    id: string,
    signal: AbortSignal | undefined,
    run: (found: {
      readonly api: CpanelApi;
      readonly site: CpanelWordPress;
    }) => Promise<T>,
    options: AccountApiOptions = {},
  ): Promise<T> {
    const { api, site } = await this.#site(id, signal, options);
    try {
      return await run({ api, site });
    } finally {
      await api.close?.();
    }
  }

  async read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "capabilities":
        return WHM_CAPABILITIES;
      case "backups":
        // The listing is the account's own; the site id only selects the account.
        return this.#withSite(request.envId, undefined, async ({ api }) => ({
          backups: await listHomeBackups(api),
        }));
      case "logs": {
        // The only log cPanel exposes per domain here is the error log.
        if (request.fileName !== "error")
          throw unsupportedReadRequest(PROVIDER, request);
        return this.#withSite(request.envId, undefined, ({ api, site }) =>
          readErrorLog(api, site.domain, request.lines),
        );
      }
      default:
        throw unsupportedReadRequest(PROVIDER, request);
    }
  }

  async action(request: ActionRequest): Promise<ActionResult> {
    switch (request.kind) {
      case "create-backup": {
        const { signal } = request;
        signal?.throwIfAborted();
        // The backup covers the whole account; the environment only has to exist.
        return this.#withSite(request.envId, signal, async ({ api }) => {
          if (request.wait === false) {
            await startAccountBackup(api, signal);
            return backupStartedResult(PROVIDER);
          }
          return this.#completed.record("backups.create", {
            backup_id: await createAccountBackup(api, this.#sleep, { signal }),
          });
        });
      }
      case "setup-novamira": {
        const { signal } = request;
        signal?.throwIfAborted();
        return this.#withSite(
          request.envId,
          signal,
          async ({ api, site }) => {
            // The cPanel setups answer as "cpanel"; this client's answer is WHM's.
            const result = await dispatchSetup(
              api,
              this.#transferFetch,
              site,
              request,
              this.#sleep,
            );
            return { ...result, provider: PROVIDER };
          },
          // The installer path uploads through a temporary cPanel session.
          { uploads: sessionUploads(this.#context, this.#whm) },
        );
      }
      default:
        throw unsupportedActionRequest(PROVIDER, request);
    }
  }

  operationStatus(operationId: string): Promise<OperationStatus> {
    return this.#completed.status(operationId);
  }

  wpCliResultsObservable(): boolean {
    return false;
  }
}

/** `options.sleep` paces the backup and WP Toolkit task polling. */
export function createWhmClientWith(
  context: ProviderClientContext,
  options: CpanelClientOptions = {},
): ProviderClient {
  return new WhmClient(context, options);
}

export const createWhmClient: ProviderClientFactory = (context) =>
  createWhmClientWith(context);
