// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** WHM API 1 transport and per-account cPanel access for one WHM server. */

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import type { ProviderClientContext } from "../factory.js";
import type { HttpBody, HttpClient } from "../http-client.js";
import {
  type CpanelApi,
  CPANEL_USERNAME,
  certificateFailure,
  NO_TOOLKIT_STATUSES,
  notAnApiAnswer,
  parseToolkitInstallations,
  runWpCli,
  TOOLKIT_INSTALLATIONS,
  type ToolkitInstallation,
  uapiEnvelopeData,
} from "./cpanel-uapi.js";

/** The cPanel service port on the same host as WHM. */
const CPANEL_PORT = "2083";

export interface WhmTarget {
  /** The WHM user the token belongs to: `root` or a reseller. */
  readonly user: string;
  /** `https://host:port` of WHM, no path. */
  readonly origin: string;
  /** `https://<host>:2083`: where each account's cPanel answers. */
  readonly cpanelOrigin: string;
}

export function whmTarget(context: ProviderClientContext): WhmTarget {
  if (context.secret.length === 0)
    throw new CliError("credential_missing", "The WHM API token is empty.");
  const user = context.identity ?? "root";
  // The user goes into the `whm <user>:<token>` header, so nothing that could
  // change its shape is accepted.
  if (!CPANEL_USERNAME.test(user))
    throw new CliError(
      "config_error",
      "Enter the WHM user that created the API token: root or a reseller user name.",
    );
  let url: URL;
  try {
    url = new URL(context.baseUrl);
  } catch {
    throw new CliError("config_error", "Enter the HTTPS WHM address.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname.replace(/\/+$/, "") !== ""
  )
    throw new CliError(
      "config_error",
      "WHM needs an HTTPS address such as https://server.example.com:2087, with no path, query or credentials.",
    );
  // The cPanel ports answer cPanel, not WHM, and the installer's session is
  // derived from this address: it must be WHM's own.
  if (url.port === "2082" || url.port === CPANEL_PORT)
    throw new CliError(
      "config_error",
      "WHM needs its own address, usually on port 2087, not the cPanel port.",
    );
  const cpanel = new URL(url.origin);
  cpanel.port = CPANEL_PORT;
  return { user, origin: url.origin, cpanelOrigin: cpanel.origin };
}

export interface WhmCallOptions {
  readonly method?: "GET" | "POST";
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
}

export interface WhmRequestInit {
  readonly method?: "GET" | "POST" | "PUT";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: HttpBody;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
}

export interface WhmApi {
  /** The WHM user the token belongs to: `root` or a reseller. */
  readonly user: string;
  readonly origin: string;
  readonly cpanelOrigin: string;
  /**
   * One JSON request carrying the WHM token to `path` (it starts with `/`)
   * below the WHM origin, for endpoints that are not WHM API 1, such as WP
   * Toolkit's `/cgi/wpt/index.php`. The same HTTP client and header as `call`,
   * but nothing is mapped: a failure reaches the caller as the HTTP client's
   * error with `details.status`, so the caller applies its own status rules
   * and then `whmGuarded`. The token goes with every request, so `path` must
   * start with `/` (anything else could turn the origin into userinfo of
   * another host): a path that does not rejects with a plain `Error`, a
   * programming mistake rather than a provider failure.
   */
  request(path: string, init?: WhmRequestInit): Promise<unknown>;
  /**
   * `/json-api/<fn>?api.version=1&...`; returns the envelope's `data` and
   * throws when `metadata.result` is not 1. A function the user's privileges
   * do not allow fails with `details.permissionDenied: true`, so a caller can
   * name the privilege to ask for.
   */
  call(
    fn: string,
    params?: Readonly<Record<string, string>>,
    options?: WhmCallOptions,
  ): Promise<unknown>;
}

/** How WHM API 1 refuses a function the user's privileges do not allow. */
const PERMISSION_DENIED = /^Permission denied\b/;

/** `call` failed because the user's privileges do not allow the function. */
export function permissionDenied(error: unknown): boolean {
  return error instanceof CliError && error.details?.permissionDenied === true;
}

const NOT_WHM =
  "This address did not answer as WHM. Check the WHM address (for example https://server.example.com:2087).";

/**
 * Turns transport and HTTP failures into messages a WHM operator can act on.
 * `notApiAnswer: false` keeps a 404 or a non-JSON 2xx answer as the HTTP
 * client's error: for WP Toolkit it says something about that endpoint, not
 * about the address being WHM.
 */
async function whmGuarded<T>(
  run: () => Promise<T>,
  { notApiAnswer = true }: { readonly notApiAnswer?: boolean } = {},
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (certificateFailure(error))
      throw new CliError(
        "network_error",
        "The WHM address has no valid certificate for its name. Use the server's hostname with a valid certificate, or ask your host which address to use.",
      );
    if (error instanceof CliError) {
      // The shared HTTP client records the response status in `details.status`.
      const status = error.details?.status;
      if (
        status === 401 ||
        status === 403 ||
        error.code === "credential_invalid"
      )
        throw new CliError(
          "credential_invalid",
          "WHM rejected the API token. Check that the WHM user is the one that created the token in WHM » Development » Manage API Tokens and that the token has not been revoked.",
        );
      if (notApiAnswer && notAnApiAnswer(error))
        throw new CliError("provider_error", NOT_WHM);
    }
    throw error;
  }
}

function limits(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal?: AbortSignal; timeoutMs?: number; totalTimeoutMs?: number } {
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined
      ? {}
      : { timeoutMs, totalTimeoutMs: timeoutMs }),
  };
}

export function createWhmApi(context: ProviderClientContext): WhmApi {
  const target = whmTarget(context);
  const token = context.secret.reveal();
  const header = `whm ${target.user}:${token}`;
  const http: HttpClient = context.createHttpClient({
    auth: {
      authorize: () => ({
        headers: { authorization: header },
        secrets: [token, header],
      }),
    },
  });
  return {
    user: target.user,
    origin: target.origin,
    cpanelOrigin: target.cpanelOrigin,
    async request(path, init = {}) {
      if (!path.startsWith("/"))
        throw new Error("A WHM request path must start with /.");
      return http.json({
        path: `${target.origin}${path}`,
        method: init.method ?? "GET",
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body }),
        ...limits(init.signal, init.timeoutMs),
      });
    },
    async call(fn, params = {}, options = {}) {
      const method = options.method ?? "GET";
      const pairs = { "api.version": "1", ...params };
      const payload:
        | { readonly query: Readonly<Record<string, string>> }
        | { readonly body: HttpBody } =
        method === "GET"
          ? { query: pairs }
          : { body: { kind: "form", value: pairs } };
      const value = await whmGuarded(() =>
        http.json({
          path: `${target.origin}/json-api/${fn}`,
          method,
          ...payload,
          ...limits(options.signal, options.timeoutMs),
        }),
      );
      const envelope = asRecord(value);
      const metadata = asRecord(envelope?.metadata);
      if (envelope === undefined || metadata === undefined)
        throw new CliError("provider_error", NOT_WHM);
      if (metadata.result === 1) return envelope.data;
      const reason = typeof metadata.reason === "string" ? metadata.reason : "";
      throw new CliError(
        "provider_error",
        reason === ""
          ? `WHM ${fn} failed.`
          : `WHM ${fn} failed: ${reason.slice(0, 300)}`,
        PERMISSION_DENIED.test(reason)
          ? { details: { permissionDenied: true } }
          : {},
      );
    },
  };
}

/**
 * WP Toolkit at the WHM level: one `/cgi/wpt/index.php` serving every
 * account's installations, with the same WHM token as everything else.
 */
export interface WhmToolkit {
  /** WHM-level installation list, fetched once per client operation; `undefined` without WP Toolkit. */
  installations(
    signal?: AbortSignal,
  ): Promise<readonly ToolkitInstallation[] | undefined>;
  wpt: CpanelApi["wpt"];
}

/**
 * The toolkit lives as long as the object: `whm.ts` creates one per public
 * client operation, so the installation list is fetched once per operation and
 * HQ's 5-minute site cache, not this memo, decides how fresh it is. `_context`
 * only keeps every WHM transport built from the same profile context; the
 * token and HTTP client are `whm`'s.
 */
export function createWhmToolkit(
  _context: ProviderClientContext,
  whm: WhmApi,
): WhmToolkit {
  // As on cPanel, 401, 403 and 404 on the detection path (the installation
  // list) mean "no WP Toolkit"; they are read before `whmGuarded` would turn
  // 401 and 403 into a rejected credential. On every other path they are.
  const wpt: CpanelApi["wpt"] = (path, init = {}) => {
    const body: HttpBody | undefined =
      init.json === undefined
        ? init.multipart
        : { kind: "json", value: init.json };
    const detection = path === TOOLKIT_INSTALLATIONS;
    return whmGuarded(
      async () => {
        try {
          return await whm.request(`/cgi/wpt/index.php${path}`, {
            method: init.method ?? "GET",
            headers: { accept: "application/json" },
            ...(body === undefined ? {} : { body }),
            signal: init.signal,
            ...(init.timeoutMs === undefined
              ? {}
              : { timeoutMs: init.timeoutMs }),
          });
        } catch (error) {
          const status =
            error instanceof CliError ? error.details?.status : undefined;
          if (
            detection &&
            typeof status === "number" &&
            NO_TOOLKIT_STATUSES.has(status)
          )
            return undefined;
          throw error;
        }
      },
      { notApiAnswer: false },
    );
  };
  let listing: Promise<readonly ToolkitInstallation[] | undefined> | undefined;
  async function list(
    signal: AbortSignal | undefined,
  ): Promise<readonly ToolkitInstallation[] | undefined> {
    let value: unknown;
    try {
      value = await wpt(
        TOOLKIT_INSTALLATIONS,
        signal === undefined ? {} : { signal },
      );
    } catch (error) {
      // A page that is not JSON is an answer WP Toolkit did not give.
      if (notAnApiAnswer(error)) return undefined;
      throw error;
    }
    if (value === undefined) return undefined;
    try {
      return parseToolkitInstallations(value);
    } catch {
      // An invalid list falls back to per-account discovery (spec §2).
      return undefined;
    }
  }
  return {
    wpt,
    installations(signal) {
      listing ??= list(signal).catch((error: unknown) => {
        // A failed fetch is not remembered: the next caller asks again.
        listing = undefined;
        throw error;
      });
      return listing;
    },
  };
}

export interface AccountApiOptions {
  /**
   * The temporary cPanel session for file uploads (`whm-session.ts`), opened
   * on the first upload. Without it uploads throw.
   */
  readonly uploads?: (user: string) => {
    multipart: CpanelApi["uapiMultipart"];
    close(): Promise<void>;
  };
}

const WP_TOOLKIT_FEATURE = "wp-toolkit";
const NO_UPLOADS = "File uploads through WHM are not available.";
const NO_ACCOUNT = "You do not have a user named";

/** One wording for an account HQ cannot reach: removed, never there, suspended, or another owner's. */
export function accountGone(user: string): CliError {
  return new CliError(
    "not_found",
    `The cPanel account ${user} is suspended, no longer exists on this server, or is not managed by this WHM user.`,
  );
}

function invalidHome(): CliError {
  return new CliError(
    "provider_error",
    "cPanel returned an invalid home directory.",
  );
}

/**
 * `verify_user_has_feature`: `has_feature` is 1 or 0 (as a number or a
 * string); any other answer is refused rather than guessed.
 */
function hasFeature(data: unknown): boolean {
  const value = asRecord(data)?.has_feature;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  throw new CliError(
    "provider_error",
    "WHM returned an invalid feature answer.",
  );
}

/** An absolute path without `..` segments, trailing slashes removed. */
function accountHome(value: unknown): string {
  const home = asRecord(value)?.home;
  if (typeof home !== "string" || !home.startsWith("/")) throw invalidHome();
  const trimmed = home.replace(/\/+$/, "");
  if (trimmed === "" || trimmed.split("/").includes("..")) throw invalidHome();
  return trimmed;
}

/**
 * Makes WHM look like one cPanel account to the cPanel modules: UAPI goes
 * through the `uapi_cpanel` proxy for `user` (root may use it for every
 * account, a reseller for the accounts it owns), WP Toolkit through the
 * WHM-level endpoint shared by `toolkit` (a reseller token gets 401 there,
 * which the installation list reads as no WP Toolkit). File uploads need a cPanel session
 * the proxy cannot give, so they go through `options.uploads`, opened on the
 * first upload and closed by `close()`.
 */
export function createAccountApi(
  whm: WhmApi,
  toolkit: WhmToolkit,
  user: string,
  options: AccountApiOptions = {},
): CpanelApi {
  let channel:
    ReturnType<NonNullable<AccountApiOptions["uploads"]>> | undefined;
  let closed = false;
  let home: Promise<string> | undefined;
  let toolkitFeature: Promise<boolean> | undefined;
  /** WHM answers a removed or never-existing account with a provider error. */
  function rethrowAccountError(error: unknown): never {
    if (
      error instanceof CliError &&
      error.code === "provider_error" &&
      error.message.includes(NO_ACCOUNT)
    )
      throw accountGone(user);
    throw error;
  }
  const api: CpanelApi = {
    username: user,
    origin: whm.cpanelOrigin,
    async uapi(module, fn, params = {}, callOptions = {}) {
      let data: unknown;
      try {
        // The account fields come last so a parameter cannot redirect the call.
        data = await whm.call(
          "uapi_cpanel",
          {
            ...params,
            "cpanel.user": user,
            "cpanel.module": module,
            "cpanel.function": fn,
          },
          callOptions,
        );
      } catch (error) {
        rethrowAccountError(error);
      }
      return uapiEnvelopeData(asRecord(data)?.uapi, module, fn);
    },
    async uapiMultipart(module, fn, body, callOptions = {}) {
      // After `close()` nothing may open a new session that no one would close.
      if (options.uploads === undefined || closed)
        throw new CliError("provider_error", NO_UPLOADS);
      channel ??= options.uploads(user);
      return channel.multipart(module, fn, body, callOptions);
    },
    wpt: toolkit.wpt,
    async toolkitInstallations(signal) {
      // Like cPanel, WP Toolkit counts for an account only when its feature
      // list has it: the server-wide list omits every other account, whose
      // WordPress then needs the Fileman discovery and the installer path.
      toolkitFeature ??= whm
        .call(
          "verify_user_has_feature",
          { user, feature: WP_TOOLKIT_FEATURE },
          { signal },
        )
        .then(hasFeature, rethrowAccountError)
        .catch((error: unknown) => {
          toolkitFeature = undefined;
          throw error;
        });
      if (!(await toolkitFeature)) return undefined;
      const all = await toolkit.installations(signal);
      if (all === undefined) return undefined;
      home ??= api
        .uapi("Variables", "get_user_information", { name: "home" }, { signal })
        .then(accountHome)
        .catch((error: unknown) => {
          home = undefined;
          throw error;
        });
      const root = await home;
      // Installations inside this account's home; a path that climbs out of it
      // with `..` is not inside it.
      return all.filter(
        (item) =>
          (item.path === root || item.path.startsWith(`${root}/`)) &&
          !item.path.split("/").includes(".."),
      );
    },
    wpCli(installationId, argv, signal) {
      return runWpCli(toolkit.wpt, installationId, argv, signal);
    },
    async close() {
      closed = true;
      const open = channel;
      channel = undefined;
      try {
        await open?.close();
      } catch {
        // Closing is best effort: the run's own outcome is what matters.
      }
    },
  };
  return api;
}
