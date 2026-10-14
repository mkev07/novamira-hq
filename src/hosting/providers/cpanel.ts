// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** cPanel account adapter over UAPI and WP Toolkit REST. */

import { CliError } from "../../errors.js";
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
import {
  type ActionResult,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderValidation,
  providerCapabilities,
} from "../types.js";
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
  domainFromEnvId,
  domainName,
} from "./cpanel-sites.js";
import {
  backupStartedResult,
  CompletedActions,
  defaultSleep,
  dispatchSetup,
} from "./cpanel-client-support.js";
import { type CpanelApi, createCpanelApi } from "./cpanel-uapi.js";

const PROVIDER = "cpanel" as const;
const NOT_AVAILABLE = "Not available through the cPanel user API";

export const CPANEL_CAPABILITIES = providerCapabilities([
  ["providers.validate", true],
  ["providers.capabilities", true],
  ["sites.list", true, "WordPress at the root of each cPanel domain"],
  ["sites.get", true],
  ["envs.list", true, "One live environment per site"],
  ["envs.get", true],
  ["backups.list", true, "Whole cPanel account backups in the home directory"],
  [
    "backups.create",
    true,
    "Backs up the whole cPanel account; counts against disk quota",
  ],
  ["backups.restore", false, "cPanel has no user-level restore API"],
  ["logs.get", true, "Domain error log"],
  ["cache.clear", false, NOT_AVAILABLE],
  ["php.restart", false, NOT_AVAILABLE],
  ["php.set-version", false, NOT_AVAILABLE],
  [
    "novamira.setup",
    true,
    "Through WP Toolkit, or with your consent a temporary installer",
  ],
  ["wp-cli.run", false, NOT_AVAILABLE],
  ["wp.plugins.install", false, NOT_AVAILABLE],
  ["wp.plugins.update", false, NOT_AVAILABLE],
  ["domains.add", false, NOT_AVAILABLE],
  ["domains.primary", false, NOT_AVAILABLE],
] as const);

/** `sleep` paces backup polling; tests replace it so they never really wait. */
export interface CpanelClientOptions {
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

class CpanelClient implements ProviderClient {
  readonly provider = PROVIDER;
  readonly #api: CpanelApi;
  readonly #configured: boolean;
  readonly #credentialSource: string;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #transferFetch: typeof fetch;
  readonly #completed = new CompletedActions(PROVIDER);

  constructor(
    context: ProviderClientContext,
    options: CpanelClientOptions = {},
  ) {
    this.#api = createCpanelApi(context);
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
            "Set this cPanel profile's api_base_url to the HTTPS panel address before connecting.",
          ),
        );
  }

  async validate(): Promise<ProviderValidation> {
    await this.#requireConfigured();
    await this.#api.uapi("DomainInfo", "list_domains");
    return {
      provider: PROVIDER,
      status: "active",
      companyId: this.#api.username,
      credential: this.#credentialSource,
    };
  }

  async #wordpress(signal?: AbortSignal): Promise<readonly CpanelWordPress[]> {
    await this.#requireConfigured();
    return (await discoverWordPress(this.#api, signal)).sites;
  }

  async #site(siteId: string, signal?: AbortSignal): Promise<CpanelWordPress> {
    const domain = domainName(siteId);
    const found = (await this.#wordpress(signal)).find(
      (entry) => entry.domain === domain,
    );
    if (!found)
      throw new CliError(
        "not_found",
        "No WordPress was found at the root of this cPanel domain.",
      );
    return found;
  }

  async listSites(options: ListSitesOptions = {}): Promise<HostingSite[]> {
    return (await this.#wordpress()).map((entry) =>
      cpanelSite(entry, options.includeEnvironments === true),
    );
  }

  async getSite(siteId: string): Promise<HostingSite> {
    return cpanelSite(await this.#site(siteId), true);
  }

  async listEnvironments(siteId: string): Promise<HostingEnvironment[]> {
    return [cpanelEnvironment(await this.#site(siteId))];
  }

  async read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "capabilities":
        return CPANEL_CAPABILITIES;
      case "backups":
        await this.#site(domainFromEnvId(request.envId));
        return { backups: await listHomeBackups(this.#api) };
      case "logs": {
        // The only log cPanel exposes per domain here is the error log.
        if (request.fileName !== "error")
          throw unsupportedReadRequest(PROVIDER, request);
        const site = await this.#site(domainFromEnvId(request.envId));
        return readErrorLog(this.#api, site.domain, request.lines);
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
        await this.#site(domainFromEnvId(request.envId));
        if (request.wait === false) {
          await startAccountBackup(this.#api, signal);
          return backupStartedResult(PROVIDER);
        }
        return this.#completed.record("backups.create", {
          backup_id: await createAccountBackup(this.#api, this.#sleep, {
            signal,
          }),
        });
      }
      case "setup-novamira": {
        const { signal } = request;
        signal?.throwIfAborted();
        const site = await this.#site(domainFromEnvId(request.envId), signal);
        return dispatchSetup(
          this.#api,
          this.#transferFetch,
          site,
          request,
          this.#sleep,
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

export function createCpanelClientWith(
  context: ProviderClientContext,
  options: CpanelClientOptions = {},
): ProviderClient {
  return new CpanelClient(context, options);
}

export const createCpanelClient: ProviderClientFactory = (context) =>
  createCpanelClientWith(context);
