// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The xCloud provider client, mapped from the xCloud Public API
 * (https://app.xcloud.host/api/v1/docs, OpenAPI 3.0.3).
 *
 * xCloud authenticates with a Sanctum personal access token sent as a bearer
 * token. A token may act on several teams; the profile's optional `companyId`
 * is the team UUID, sent as `X-Team-Id`. Without it HQ uses the first team the
 * token is granted, the same rule as InstaWP.
 *
 * Every xCloud resource is addressed by UUID. HQ models a production WordPress
 * site as a hosting site whose `live` environment shares the site's UUID; the
 * site's staging sites are its other environments, each keyed by its own site
 * UUID. Staging sites also appear as top-level sites in `GET /sites`, so the
 * inventory folds them under their production site whenever environments are
 * included.
 *
 * xCloud's API cannot install a plugin, run WP-CLI, create or push WordPress
 * staging sites, or restore a backup. Those capabilities are published as
 * unsupported, so HQ never approximates them through cron jobs or other
 * command-execution surfaces the API happens to offer.
 *
 * Several xCloud reads (`/wordpress/status`, `/access-logs`) run a task over SSH
 * on the customer's server. The inventory methods therefore use only database
 * backed endpoints, and the SSH-backed reads are reachable only from an explicit
 * user request.
 */

import { CliError } from "../../errors.js";
import {
  type ActionRequest,
  type ListSitesOptions,
  type ProviderClient,
  type ReadRequest,
  assertNever,
  unsupportedActionRequest,
  unsupportedReadRequest,
} from "../client.js";
import type {
  ProviderClientContext,
  ProviderClientFactory,
} from "../factory.js";
import {
  type HttpClient,
  type HttpRequest,
  type PollOptions,
  bearerAuth,
  jsonBody,
} from "../http-client.js";
import {
  type ActionResult,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderCapabilityInput,
  type ProviderValidation,
  type Query,
  providerCapabilities,
  serializeProviderCapability,
} from "../types.js";

const PROVIDER = "xcloud" as const;

/** xCloud's maximum `per_page` for sites, backups, events and WordPress items. */
const PAGE_SIZE = 100;

/** Hard stop for paginated reads, far above any real xCloud team. */
const MAX_PAGES = 100;

/** xCloud's access-log endpoint accepts 1–1000 entries. */
const ACCESS_LOG_MAX_ENTRIES = 1000;

/** The smallest output window `GET /sites/{uuid}/events/{task_uuid}` accepts. */
const EVENT_OUTPUT_WINDOW = 1000;

const ACTIVITY_DEFAULT_PAGE_SIZE = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const NOTE_NOT_MAPPED = "not mapped for xCloud in Novamira";
const NOTE_NO_API = "not available in the xCloud Public API";

const XCLOUD_CAPABILITIES: readonly ProviderCapabilityInput[] = [
  ["providers.validate", true, "uses GET /user and GET /teams"],
  "providers.capabilities",
  ["sites.list", true, "lists WordPress sites with GET /sites"],
  ["sites.get", true, "uses GET /sites/{uuid}"],
  [
    "envs.list",
    true,
    "the production site plus its staging sites from GET /sites/{uuid}/staging-sites",
  ],
  ["envs.get", true, "environment ids are xCloud site UUIDs"],
  [
    "ops.get",
    true,
    "uses GET /sites/{uuid}/events/{task_uuid}; operation ids are site_uuid:task_uuid",
  ],
  ["ops.wait", true, "polls GET /sites/{uuid}/events/{task_uuid}"],
  ["regions.list", false, NOTE_NOT_MAPPED],
  ["activity.list", true, "uses GET /sites/{uuid}/events"],
  ["sites.create", false, NOTE_NOT_MAPPED],
  ["sites.create-plain", false, NOTE_NOT_MAPPED],
  ["sites.clone", false, NOTE_NOT_MAPPED],
  [
    "envs.create",
    false,
    "xCloud creates WordPress staging sites only from its dashboard",
  ],
  ["envs.create-plain", false, NOTE_NO_API],
  ["envs.clone", false, NOTE_NO_API],
  [
    "envs.push",
    false,
    "xCloud pushes WordPress staging sites only from its dashboard",
  ],
  ["domains.list", true, "uses GET /sites/{uuid}/domains"],
  ["dns.domains.list", false, NOTE_NOT_MAPPED],
  ["dns.records.list", false, NOTE_NOT_MAPPED],
  ["backups.list", true, "uses GET /sites/{uuid}/backups"],
  ["backups.downloadable", false, NOTE_NO_API],
  [
    "backups.create",
    true,
    "uses POST /sites/{uuid}/backup; xCloud backups carry no tag",
  ],
  ["backups.restore", false, NOTE_NO_API],
  [
    "cache.clear",
    true,
    "purges the full-page cache with POST /sites/{uuid}/cache/purge",
  ],
  ["php.restart", false, NOTE_NOT_MAPPED],
  [
    "php.set-version",
    false,
    "xCloud sets PHP versions per server, not per site",
  ],
  ["wp.plugins.list", true, "uses GET /sites/{uuid}/wordpress/plugins"],
  ["wp.plugins.install", false, NOTE_NO_API],
  [
    "wp.plugins.update",
    true,
    "uses POST /sites/{uuid}/wordpress/update; updates to the version xCloud reports as available",
  ],
  ["wp.plugins.update-all", true, "uses POST /sites/{uuid}/wordpress/update"],
  ["wp.themes.list", true, "uses GET /sites/{uuid}/wordpress/themes"],
  [
    "wp.themes.update",
    true,
    "uses POST /sites/{uuid}/wordpress/update; updates to the version xCloud reports as available",
  ],
  ["wp.themes.update-all", true, "uses POST /sites/{uuid}/wordpress/update"],
  ["wp-cli.run", false, NOTE_NO_API],
  [
    "logs.get",
    true,
    "access log only, read over SSH by GET /sites/{uuid}/access-logs",
  ],
  ["analytics.usage", false, NOTE_NOT_MAPPED],
  ["analytics.env", false, NOTE_NOT_MAPPED],
  ["novamira.setup", false, "xCloud's API cannot install plugins"],
];

type JsonObject = Readonly<Record<string, unknown>>;

type WordPressItemType = "plugin" | "theme";

/** Construct an xCloud client. The token is revealed only for the header. */
export const createXCloudClient: ProviderClientFactory = (
  context: ProviderClientContext,
): ProviderClient => {
  if (context.secret.length === 0) {
    throw new CliError("credential_missing", "xCloud requires an API token.", {
      details: { provider: PROVIDER, credential: context.credentialSource },
    });
  }
  const configuredTeam = (context.companyId ?? "").trim();
  const base = context.createHttpClient({
    auth: bearerAuth(context.secret.reveal()),
    defaultHeaders: { accept: "application/json" },
  });
  let firstTeam: Promise<string> | undefined;

  /**
   * The team every request acts on: the profile's team, else the first team
   * the token is granted, as InstaWP profiles do. It is always sent as
   * `X-Team-Id` so the team never silently follows the token's default.
   * Construction stays offline; the lookup happens on the first request.
   */
  async function teamId(): Promise<string> {
    if (configuredTeam !== "") {
      if (!UUID.test(configuredTeam)) {
        throw new CliError(
          "usage_error",
          "The xCloud team must be a team UUID from GET /teams.",
          { details: { provider: PROVIDER } },
        );
      }
      return configuredTeam.toLowerCase();
    }
    if (firstTeam !== undefined) return firstTeam;
    const lookup = grantedTeams().then((teams) => {
      const first = teams[0];
      if (first === undefined) {
        throw new CliError(
          "credential_invalid",
          "This xCloud token is not granted access to any team.",
          { details: { provider: PROVIDER } },
        );
      }
      return first;
    });
    firstTeam = lookup;
    // A failed lookup is retried by the next request, not cached.
    lookup.catch(() => {
      if (firstTeam === lookup) firstTeam = undefined;
    });
    return lookup;
  }

  /** The team UUIDs the token may act on, in xCloud's order. */
  async function grantedTeams(): Promise<string[]> {
    const teams = envelopeData(await base.json({ path: "/teams" }), "/teams");
    return (Array.isArray(teams) ? teams : []).flatMap((entry) => {
      const id = stringField(asObject(entry), "uuid");
      return id !== undefined && UUID.test(id) ? [id.toLowerCase()] : [];
    });
  }

  async function withTeam(request: HttpRequest): Promise<HttpRequest> {
    return {
      ...request,
      headers: { ...request.headers, "x-team-id": await teamId() },
    };
  }

  const http: HttpClient = {
    baseUrl: base.baseUrl,
    async request<T>(request: HttpRequest) {
      return base.request<T>(await withTeam(request));
    },
    async json<T>(request: HttpRequest) {
      return base.json<T>(await withTeam(request));
    },
    async poll<T>(request: HttpRequest, options: PollOptions<T>) {
      return base.poll<T>(await withTeam(request), options);
    },
  };

  /* ---------------------------------------------------------------------- */
  /* Requests                                                               */
  /* ---------------------------------------------------------------------- */

  /** GET an xCloud envelope and return its `data`. */
  async function getData(path: string, query?: Query): Promise<unknown> {
    const payload = await http.json({
      path,
      ...(query === undefined ? {} : { query }),
    });
    return envelopeData(payload, path);
  }

  /** Every `items` entry of a paginated `{items, pagination}` list. */
  async function getAllItems(
    path: string,
    query: Query = [],
  ): Promise<JsonObject[]> {
    const items: JsonObject[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = asObject(
        await getData(path, [
          ...query,
          ["page", String(page)],
          ["per_page", String(PAGE_SIZE)],
        ]),
      );
      const pageItems = data.items;
      if (!Array.isArray(pageItems)) break;
      for (const entry of pageItems) items.push(asObject(entry));
      const pagination = asObject(data.pagination);
      const lastPage = integerField(pagination, "last_page") ?? page;
      if (page >= lastPage || pageItems.length === 0) break;
    }
    return items;
  }

  async function postAction(
    action: string,
    path: string,
    body?: unknown,
  ): Promise<{ readonly result: ActionResult; readonly data: JsonObject }> {
    const response = await http.request({
      path,
      method: "POST",
      ...(body === undefined ? {} : { body: jsonBody(body) }),
    });
    const raw = response.data ?? null;
    const envelope = asObject(raw);
    const message = stringField(envelope, "message");
    return {
      result: {
        provider: PROVIDER,
        action,
        status: response.status,
        ...(message === undefined || message === "" ? {} : { message }),
        raw,
      },
      data: asObject(envelope.data),
    };
  }

  /** An action whose response names the xCloud task that tracks it. */
  async function taskAction(
    action: string,
    siteId: string,
    path: string,
    body?: unknown,
  ): Promise<ActionResult> {
    const { result, data } = await postAction(action, path, body);
    const task = stringField(data, "task_uuid");
    return task === undefined || !UUID.test(task)
      ? result
      : { ...result, operationId: `${siteId}:${task}` };
  }

  /* ---------------------------------------------------------------------- */
  /* ProviderClient                                                         */
  /* ---------------------------------------------------------------------- */

  async function validate(): Promise<ProviderValidation> {
    const team = await teamId();
    if (configuredTeam !== "" && !(await grantedTeams()).includes(team)) {
      throw new CliError(
        "credential_invalid",
        "This xCloud token is not granted access to the configured team.",
        { details: { provider: PROVIDER } },
      );
    }
    // Proves the token authenticates against the selected team.
    await getData("/user");
    return {
      provider: PROVIDER,
      status: "active",
      companyId: team,
      credential: context.credentialSource,
    };
  }

  async function listSites(options?: ListSitesOptions): Promise<HostingSite[]> {
    const rows = await getAllItems("/sites", [["type", "wordpress"]]);
    if (options?.includeEnvironments !== true)
      return rows.map((row) => toSite(row));

    // Staging sites are also top-level sites. Fold each one under its
    // production site, sequentially to stay inside xCloud's rate limit.
    const staging = new Set<string>();
    const environments = new Map<string, HostingEnvironment[]>();
    for (const row of rows) {
      const id = siteUuid(row);
      const children = await stagingSites(id);
      if (children === undefined) continue;
      for (const child of children) staging.add(child.id);
      environments.set(id, [liveEnvironment(row), ...children]);
    }
    return rows
      .filter((row) => !staging.has(siteUuid(row)))
      .map((row) =>
        toSite(row, environments.get(siteUuid(row)) ?? [liveEnvironment(row)]),
      );
  }

  async function getSite(siteId: string): Promise<HostingSite> {
    const id = requireUuid(siteId);
    const row = asObject(await getData(`/sites/${id}`));
    const children = await stagingSites(id);
    return toSite(row, [liveEnvironment(row), ...(children ?? [])]);
  }

  async function listEnvironments(
    siteId: string,
  ): Promise<HostingEnvironment[]> {
    return [...((await getSite(siteId)).environments ?? [])];
  }

  /**
   * The staging environments of a production site, or `undefined` when the
   * site is itself a staging site (xCloud answers 422 for those).
   */
  async function stagingSites(
    siteId: string,
  ): Promise<HostingEnvironment[] | undefined> {
    const response = await http.request({
      path: `/sites/${siteId}/staging-sites`,
      acceptStatuses: [422],
    });
    if (response.status === 422) return undefined;
    const data = asObject(envelopeData(response.data, "staging-sites"));
    const items = Array.isArray(data.items) ? data.items : [];
    return items.flatMap((entry) => {
      const row = asObject(entry);
      const id = stringField(row, "uuid");
      if (id === undefined || !UUID.test(id)) return [];
      const name = stringField(row, "name") ?? id;
      return [
        {
          id: id.toLowerCase(),
          name: "staging",
          displayName: name,
          isBlocked: false,
          isPremium: false,
          primaryDomain: name,
        },
      ];
    });
  }

  async function read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "capabilities":
        return providerCapabilities(XCLOUD_CAPABILITIES).map(
          serializeProviderCapability,
        );
      case "site-domains":
        return getData(`/sites/${requireUuid(request.envId)}/domains`);
      case "backups":
        return getAllItems(`/sites/${requireUuid(request.envId)}/backups`);
      case "plugins":
        return getAllItems(
          `/sites/${requireUuid(request.envId)}/wordpress/plugins`,
        );
      case "themes":
        return getAllItems(
          `/sites/${requireUuid(request.envId)}/wordpress/themes`,
        );
      case "logs": {
        const envId = requireUuid(request.envId);
        if (request.fileName !== "access") {
          throw new CliError(
            "usage_error",
            'xCloud supports only the "access" log file.',
            {
              details: {
                provider: PROVIDER,
                fileName: request.fileName,
                supported: ["access"],
              },
            },
          );
        }
        const limit = Math.min(
          Math.max(1, Math.trunc(request.lines)),
          ACCESS_LOG_MAX_ENTRIES,
        );
        return getData(`/sites/${envId}/access-logs`, [
          ["limit", String(limit)],
        ]);
      }
      case "activity":
        return readActivity(request.query ?? []);
      case "regions":
      case "site-domain-verification":
      case "dns-domains":
      case "dns-records":
      case "downloadable-backups":
      case "redirects":
      case "denied-ips":
      case "company-plugins":
      case "company-themes":
      case "analytics-usage":
      case "analytics-env":
      case "file-list":
        throw unsupportedReadRequest(PROVIDER, request);
      default:
        return assertNever(request);
    }
  }

  /** Site events, paged by the neutral `limit`/`offset` query. */
  async function readActivity(query: Query): Promise<unknown> {
    let siteId = "";
    let limit = ACTIVITY_DEFAULT_PAGE_SIZE;
    let offset = 0;
    for (const [key, value] of query) {
      if (value === "") continue;
      switch (key) {
        case "site_id":
          siteId = value;
          break;
        case "limit":
          limit = boundedInteger(value, "limit", 1);
          break;
        case "offset":
          offset = boundedInteger(value, "offset", 0);
          break;
        default:
          throw new CliError(
            "provider_unsupported",
            `xCloud does not support the "${key}" activity filter.`,
            { details: { provider: PROVIDER, filter: key } },
          );
      }
    }
    if (siteId === "") {
      throw new CliError(
        "usage_error",
        "xCloud activity is per site; select a site.",
        { details: { provider: PROVIDER } },
      );
    }
    const perPage = Math.min(limit, PAGE_SIZE);
    return getData(`/sites/${requireUuid(siteId)}/events`, [
      ["page", String(Math.floor(offset / perPage) + 1)],
      ["per_page", String(perPage)],
    ]);
  }

  async function action(request: ActionRequest): Promise<ActionResult> {
    switch (request.kind) {
      case "clear-cache": {
        if (request.cache !== "site") {
          throw new CliError(
            "provider_unsupported",
            "xCloud clears only the site's full-page cache through HQ.",
            { details: { provider: PROVIDER, cache: request.cache } },
          );
        }
        const siteId = requireUuid(cacheSiteId(request.body));
        return taskAction(
          "cache.clear",
          siteId,
          `/sites/${siteId}/cache/purge`,
        );
      }
      case "create-backup": {
        const siteId = requireUuid(request.envId);
        return taskAction("backups.create", siteId, `/sites/${siteId}/backup`, {
          type: backupDestination(request.body),
        });
      }
      case "update-plugin":
        return updateOne("plugin", request.envId, request.body);
      case "update-theme":
        return updateOne("theme", request.envId, request.body);
      case "bulk-update-plugins":
        return updateAll("plugin", request.envId, request.body);
      case "bulk-update-themes":
        return updateAll("theme", request.envId, request.body);
      case "create-site":
      case "create-environment":
      case "push-environment":
      case "restore-backup":
      case "restart-php":
      case "set-php-version":
      case "add-domain":
      case "change-primary-domain":
      case "run-wp-cli":
      case "set-denied-ips":
      case "apply-redirects":
      case "setup-novamira":
        throw unsupportedActionRequest(PROVIDER, request);
      default:
        return assertNever(request);
    }
  }

  /**
   * Update one item. xCloud always installs the version it reports as
   * available, so a requested version is checked against that first rather
   * than silently replaced by another.
   */
  async function updateOne(
    type: WordPressItemType,
    envId: string,
    body: unknown,
  ): Promise<ActionResult> {
    const siteId = requireUuid(envId);
    const object = objectBody(body);
    const name = stringField(object, "name") ?? "";
    if (name === "") {
      throw new CliError(
        "usage_error",
        `xCloud requires the ${type} slug as "name".`,
        { details: { provider: PROVIDER } },
      );
    }
    const requested = stringField(object, "update_version") ?? "";
    if (requested !== "") {
      const items = await getAllItems(`/sites/${siteId}/wordpress/${type}s`);
      const item = items.find((entry) => stringField(entry, "slug") === name);
      const available =
        item === undefined ? undefined : stringField(item, "available_version");
      if (available !== requested) {
        throw new CliError(
          "provider_unsupported",
          `xCloud can update ${name} only to the version it reports as available${available === undefined ? "" : ` (${available})`}.`,
          {
            details: {
              provider: PROVIDER,
              requested,
              available: available ?? null,
            },
          },
        );
      }
    }
    return sendUpdate(type, siteId, [name]);
  }

  async function updateAll(
    type: WordPressItemType,
    envId: string,
    body: unknown,
  ): Promise<ActionResult> {
    const siteId = requireUuid(envId);
    const entries = objectBody(body)[`${type}s`];
    const slugs =
      entries === undefined
        ? []
        : Array.isArray(entries)
          ? entries.map((entry) => stringField(asObject(entry), "name") ?? "")
          : [""];
    if (slugs.some((slug) => slug === "")) {
      throw new CliError(
        "usage_error",
        `xCloud expects ${type}s as a list of {"name": slug} objects.`,
        { details: { provider: PROVIDER } },
      );
    }
    return sendUpdate(type, siteId, slugs);
  }

  async function sendUpdate(
    type: WordPressItemType,
    siteId: string,
    slugs: readonly string[],
  ): Promise<ActionResult> {
    // xCloud has no polling endpoint for WordPress update operations yet, so
    // the result carries no operation id.
    const { result } = await postAction(
      slugs.length === 1 ? `wp.${type}s.update` : `wp.${type}s.update-all`,
      `/sites/${siteId}/wordpress/update`,
      { type, ...(slugs.length === 0 ? {} : { slugs }) },
    );
    return result;
  }

  async function operationStatus(
    operationId: string,
  ): Promise<OperationStatus> {
    const [siteId, taskId] = parseOperationId(operationId);
    const response = await http.request({
      path: `/sites/${siteId}/events/${taskId}`,
      query: [["limit", String(EVENT_OUTPUT_WINDOW)]],
    });
    const event = asObject(envelopeData(response.data, "events"));
    const state = stringField(event, "status") ?? "";
    const done = ["finished", "failed", "timeout", "killed"].includes(state);
    const failed = done && state !== "finished";
    // Task output can hold server details; the status evidence carries none.
    const raw = {
      uuid: stringField(event, "uuid") ?? taskId,
      name: stringField(event, "name") ?? null,
      status: state,
      exit_code: integerField(event, "exit_code") ?? null,
    };
    return {
      provider: PROVIDER,
      operationId,
      status: response.status,
      done,
      failed,
      message: state === "" ? "unknown" : state,
      raw,
    };
  }

  return {
    provider: PROVIDER,
    validate,
    listSites,
    getSite,
    listEnvironments,
    read,
    action,
    operationStatus,
    // xCloud has no WP-CLI endpoint at all.
    wpCliResultsObservable: () => false,
  };
};

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

function toSite(
  row: JsonObject,
  environments?: readonly HostingEnvironment[],
): HostingSite {
  const id = siteUuid(row);
  const domain =
    stringField(row, "domain_name") ?? stringField(row, "name") ?? "";
  const name = stringField(row, "name") ?? domain;
  return {
    id,
    name,
    displayName: name,
    status: siteStatus(row),
    ...(domain === "" ? {} : { primaryDomain: domain }),
    ...(environments === undefined ? {} : { environments }),
  };
}

function liveEnvironment(row: JsonObject): HostingEnvironment {
  const site = toSite(row);
  return {
    id: site.id,
    name: "live",
    displayName: site.displayName,
    isBlocked: site.status === "suspended",
    isPremium: false,
    ...(site.primaryDomain === undefined
      ? {}
      : { primaryDomain: site.primaryDomain }),
  };
}

function siteStatus(row: JsonObject): string {
  const status = (stringField(row, "status") ?? "").toLowerCase();
  const deploy = stringField(row, "deploy_state") ?? "";
  if (status === "provisioned" && deploy === "deployed") return "active";
  if (deploy === "failed") return "failed";
  if (deploy === "in_progress") return "provisioning";
  return status === "" ? "unknown" : status;
}

/* -------------------------------------------------------------------------- */
/* Request shaping                                                            */
/* -------------------------------------------------------------------------- */

/** Unwrap `{success, message, data}`, refusing an envelope that reports failure. */
function envelopeData(payload: unknown, path: string): unknown {
  const envelope = asObject(payload);
  if (envelope.success !== true) {
    throw new CliError(
      "provider_error",
      "The xCloud API did not confirm the request.",
      { details: { provider: PROVIDER, path } },
    );
  }
  return envelope.data ?? null;
}

/** The UUID of a site row xCloud returned; a malformed one is xCloud's fault. */
function siteUuid(row: JsonObject): string {
  const value = stringField(row, "uuid");
  if (value === undefined || !UUID.test(value)) {
    throw new CliError(
      "provider_error",
      "xCloud returned a site without a valid UUID.",
      { details: { provider: PROVIDER } },
    );
  }
  return value.toLowerCase();
}

function requireUuid(value: string | undefined): string {
  if (value === undefined || !UUID.test(value)) {
    throw new CliError(
      "usage_error",
      "xCloud site and environment ids are UUIDs.",
      { details: { provider: PROVIDER } },
    );
  }
  return value.toLowerCase();
}

function parseOperationId(operationId: string): [string, string] {
  const [site, task, ...rest] = operationId.split(":");
  if (
    site === undefined ||
    task === undefined ||
    rest.length > 0 ||
    !UUID.test(site) ||
    !UUID.test(task)
  ) {
    throw new CliError(
      "usage_error",
      "xCloud operation ids are site_uuid:task_uuid.",
      { details: { provider: PROVIDER } },
    );
  }
  return [site.toLowerCase(), task.toLowerCase()];
}

/** The site a cache purge targets, under the neutral body keys. */
function cacheSiteId(body: unknown): string | undefined {
  const object = objectBody(body);
  for (const key of ["environment_id", "envId", "site_id", "siteId"]) {
    const value = stringField(object, key);
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** xCloud backups go to `local` storage unless `remote` is asked for. */
function backupDestination(body: unknown): "local" | "remote" {
  const type = objectBody(body).type;
  if (type === undefined || type === "local") return "local";
  if (type === "remote") return "remote";
  throw new CliError(
    "usage_error",
    'xCloud backup type must be "local" or "remote".',
    { details: { provider: PROVIDER } },
  );
}

function boundedInteger(value: string, name: string, minimum: number): number {
  if (!/^\d+$/u.test(value)) {
    throw new CliError(
      "usage_error",
      `Invalid xCloud activity ${name} "${value}".`,
      { details: { provider: PROVIDER, [name]: value } },
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new CliError(
      "usage_error",
      `Invalid xCloud activity ${name} "${value}".`,
      { details: { provider: PROVIDER, [name]: value } },
    );
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Value helpers                                                              */
/* -------------------------------------------------------------------------- */

function objectBody(body: unknown): JsonObject {
  if (body === undefined || body === null) return {};
  if (typeof body === "object" && !Array.isArray(body)) {
    return body as JsonObject;
  }
  throw new CliError("usage_error", "The request body must be a JSON object.", {
    details: { provider: PROVIDER },
  });
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function integerField(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}
