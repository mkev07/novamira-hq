// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** cPanel UAPI and WP Toolkit REST transport for one cPanel account. */

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import type { ProviderClientContext } from "../factory.js";
import type { HttpBody, HttpClient } from "../http-client.js";

export const CPANEL_USERNAME = /^[a-z][a-z0-9_-]{0,31}$/;

export interface CpanelTarget {
  /** `https://host:port`, no path. */
  readonly origin: string;
  readonly username: string;
}

export function cpanelTarget(context: ProviderClientContext): CpanelTarget {
  if (context.secret.length === 0)
    throw new CliError("credential_missing", "The cPanel API token is empty.");
  const username = context.identity;
  if (username === undefined || username === "")
    throw new CliError(
      "credential_missing",
      "Enter the cPanel username that owns the API token.",
    );
  if (!CPANEL_USERNAME.test(username))
    throw new CliError(
      "config_error",
      "The cPanel username must start with a lowercase letter and use only lowercase letters, digits, - or _ (32 characters at most).",
    );
  let url: URL;
  try {
    url = new URL(context.baseUrl);
  } catch {
    throw new CliError("config_error", "Enter the HTTPS cPanel address.");
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
      "cPanel needs an HTTPS panel address such as https://server.example.com:2083, with no path, query or credentials.",
    );
  return { origin: url.origin, username };
}

export interface CpanelUapiOptions {
  readonly method?: "GET" | "POST";
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
}

export interface ToolkitInstallation {
  readonly id: number;
  readonly url: string;
  /** Absolute path of the installation on the server. */
  readonly path: string;
  readonly version: string;
  readonly alive: boolean;
  readonly multisite: boolean;
}

export interface WptInit {
  readonly method?: "GET" | "POST" | "PUT";
  readonly json?: unknown;
  readonly multipart?: Extract<HttpBody, { kind: "multipart" }>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CpanelApi {
  readonly username: string;
  readonly origin: string;
  /** `GET|POST /execute/<module>/<fn>`; returns the envelope's `data`. */
  uapi(
    module: string,
    fn: string,
    params?: Readonly<Record<string, string>>,
    options?: CpanelUapiOptions,
  ): Promise<unknown>;
  /**
   * `POST /execute/<module>/<fn>` with a multipart body (file uploads); the
   * envelope is read exactly as for `uapi`. Never retried: a POST is not.
   */
  uapiMultipart(
    module: string,
    fn: string,
    body: Extract<HttpBody, { kind: "multipart" }>,
    options?: Omit<CpanelUapiOptions, "method">,
  ): Promise<unknown>;
  /**
   * WP Toolkit REST below `/3rdparty/wpt/index.php`. HTTP 401, 403 or 404 on
   * the installation list (detection) mean the account has no WP Toolkit and
   * return `undefined`: cPanel answers 401 with its HTML login page when the
   * feature is off for the account. Every other path throws, and a rejected
   * credential there stays `credential_invalid`.
   */
  wpt(path: string, init?: WptInit): Promise<unknown>;
  /** `undefined` when WP Toolkit is not available to this account. */
  toolkitInstallations(
    signal?: AbortSignal,
  ): Promise<readonly ToolkitInstallation[] | undefined>;
  /**
   * Runs one WP-CLI command (an argv array, never a shell string) through WP
   * Toolkit's internal WP-CLI endpoint and returns its stdout. Any answer that
   * is not exactly `{exitCode: 0, stdout, stderr}` is refused: the endpoint is
   * not part of WP Toolkit's public API, so a changed shape stops the caller.
   */
  wpCli(
    installationId: number,
    argv: readonly string[],
    signal?: AbortSignal,
  ): Promise<string>;
  /** Releases resources a transport opened for this run (WHM's temporary session). */
  close?(): Promise<void>;
}

/** The installation list: also the path whose 401/403/404 mean "no WP Toolkit". */
export const TOOLKIT_INSTALLATIONS = "/v1/installations";
/** What the installation list answers when WP Toolkit is not available. */
export const NO_TOOLKIT_STATUSES: ReadonlySet<number> = new Set([
  401, 403, 404,
]);
/** Rate limiting and gateway failures say nothing about the response shape. */
const BUSY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

function invalidInstallations(): CliError {
  return new CliError(
    "provider_error",
    "WP Toolkit returned an invalid installation list.",
  );
}

function unconfirmedCommand(status?: number): CliError {
  return new CliError(
    "provider_error",
    "WP Toolkit did not confirm the command. Install Novamira from WordPress → Plugins, then connect the site by URL.",
    status === undefined ? {} : { details: { status } },
  );
}

function toolkitInstallation(item: unknown): ToolkitInstallation {
  const record = asRecord(item);
  const status = asRecord(record?.status);
  if (
    record === undefined ||
    status === undefined ||
    typeof record.id !== "number" ||
    !Number.isSafeInteger(record.id) ||
    record.id <= 0 ||
    typeof record.url !== "string" ||
    typeof record.path !== "string" ||
    typeof record.version !== "string" ||
    typeof status.alive !== "boolean" ||
    typeof status.multisite !== "boolean"
  )
    throw invalidInstallations();
  return {
    id: record.id,
    url: record.url,
    path: record.path,
    version: record.version,
    alive: status.alive,
    multisite: status.multisite,
  };
}

/** Maps a WP Toolkit installation list; anything but a valid array throws. */
export function parseToolkitInstallations(
  value: unknown,
): readonly ToolkitInstallation[] {
  if (!Array.isArray(value)) throw invalidInstallations();
  return value.map(toolkitInstallation);
}

const CERTIFICATE_CODES =
  /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|UNABLE_TO_GET_ISSUER/;

export function certificateFailure(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current !== undefined && current !== null && depth < 5;
    depth++
  ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CERTIFICATE_CODES.test(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const NOT_A_PANEL =
  "This address did not answer as a cPanel panel. Check the cPanel address (for example https://server.example.com:2083).";

/**
 * UAPI and WHM API 1 answer every known function with a JSON envelope, even
 * for a missing file. A 404, or a successful answer that is not JSON (a web
 * page), means the address is not a cPanel or WHM server.
 */
export function notAnApiAnswer(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  const status = error.details?.status;
  return (
    status === 404 ||
    (typeof status === "number" &&
      status >= 200 &&
      status < 300 &&
      error.cause instanceof SyntaxError)
  );
}

/** Turns transport and HTTP failures into messages a cPanel user can act on. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (certificateFailure(error))
      throw new CliError(
        "network_error",
        "The cPanel address has no valid certificate for its name. Use the address with a valid certificate, usually https://cpanel.<your domain>, or ask your host which address to use.",
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
          "cPanel rejected the username and API token. Check that the token belongs to this cPanel username and has not been revoked.",
        );
    }
    throw error;
  }
}

/**
 * Reads a UAPI envelope: `data` when `status` is 1, otherwise a provider error
 * carrying the first cPanel error. Shared by every transport that returns the
 * envelope unchanged (cPanel's own API and WHM's `uapi_cpanel` proxy).
 */
export function uapiEnvelopeData(
  value: unknown,
  module: string,
  fn: string,
): unknown {
  const envelope = asRecord(value);
  if (envelope === undefined || typeof envelope.status !== "number")
    throw new CliError(
      "provider_error",
      "cPanel returned an unexpected response; check the panel address.",
    );
  if (envelope.status === 1) return envelope.data;
  const errors = Array.isArray(envelope.errors)
    ? envelope.errors.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  throw new CliError(
    "provider_error",
    `cPanel ${module}::${fn} failed${
      errors[0] === undefined ? "." : `: ${errors[0].slice(0, 300)}`
    }`,
  );
}

/**
 * Runs one WP-CLI command (an argv array, never a shell string) through WP
 * Toolkit's internal WP-CLI endpoint and returns its stdout, whatever the
 * transport `wpt` is. Any answer that is not exactly `{exitCode: 0, stdout,
 * stderr}` is refused.
 */
export async function runWpCli(
  wpt: CpanelApi["wpt"],
  installationId: number,
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  let value: unknown;
  try {
    value = await wpt(
      `/v1/installations/${String(installationId)}/features/wp-cli`,
      {
        method: "POST",
        json: { command: argv, env: null },
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 60_000,
      },
    );
  } catch (error) {
    // An HTTP answer other than a rejected credential or a busy server
    // means the endpoint no longer behaves as observed (a string `command`
    // answers HTTP 500). Busy answers keep the HTTP client's retryable
    // error; transport failures, timeouts and aborts keep their own.
    const status =
      error instanceof CliError ? error.details?.status : undefined;
    if (
      error instanceof CliError &&
      error.code !== "credential_invalid" &&
      typeof status === "number" &&
      !BUSY_STATUSES.has(status)
    )
      throw unconfirmedCommand(status);
    throw error;
  }
  const result = asRecord(value);
  if (
    result?.exitCode !== 0 ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  )
    throw unconfirmedCommand();
  return result.stdout;
}

export function createCpanelApi(context: ProviderClientContext): CpanelApi {
  const target = cpanelTarget(context);
  const token = context.secret.reveal();
  const header = `cpanel ${target.username}:${token}`;
  const http: HttpClient = context.createHttpClient({
    auth: {
      authorize: () => ({
        headers: { authorization: header },
        secrets: [token, header],
      }),
    },
  });
  async function execute(
    module: string,
    fn: string,
    method: "GET" | "POST",
    payload:
      | { readonly query: Readonly<Record<string, string>> }
      | { readonly body: HttpBody },
    options: Omit<CpanelUapiOptions, "method">,
  ): Promise<unknown> {
    const value = await guarded(async () => {
      try {
        return await http.json({
          path: `${target.origin}/execute/${module}/${fn}`,
          method,
          ...payload,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.timeoutMs === undefined
            ? {}
            : {
                timeoutMs: options.timeoutMs,
                totalTimeoutMs: options.timeoutMs,
              }),
        });
      } catch (error) {
        if (notAnApiAnswer(error))
          throw new CliError("provider_error", NOT_A_PANEL);
        throw error;
      }
    });
    return uapiEnvelopeData(value, module, fn);
  }
  const api: CpanelApi = {
    username: target.username,
    origin: target.origin,
    uapi(module, fn, params = {}, options = {}) {
      const method = options.method ?? "GET";
      return execute(
        module,
        fn,
        method,
        method === "GET"
          ? { query: params }
          : { body: { kind: "form", value: params } },
        options,
      );
    },
    uapiMultipart(module, fn, body, options = {}) {
      return execute(module, fn, "POST", { body }, options);
    },
    async wpt(path, init = {}) {
      const body: HttpBody | undefined =
        init.json === undefined
          ? init.multipart
          : { kind: "json", value: init.json };
      const detection = path === TOOLKIT_INSTALLATIONS;
      // The status is read before `guarded` turns 401 and 403 into a rejected
      // credential: on the detection path they only mean "no WP Toolkit". The
      // token is proven by the UAPI call discovery makes first.
      return guarded(async () => {
        try {
          return await http.json({
            path: `${target.origin}/3rdparty/wpt/index.php${path}`,
            method: init.method ?? "GET",
            headers: { accept: "application/json" },
            ...(body === undefined ? {} : { body }),
            ...(init.signal === undefined ? {} : { signal: init.signal }),
            ...(init.timeoutMs === undefined
              ? {}
              : {
                  timeoutMs: init.timeoutMs,
                  totalTimeoutMs: init.timeoutMs,
                }),
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
      });
    },
    async toolkitInstallations(signal) {
      const value = await api.wpt(
        TOOLKIT_INSTALLATIONS,
        signal === undefined ? {} : { signal },
      );
      return value === undefined ? undefined : parseToolkitInstallations(value);
    },
    wpCli(installationId, argv, signal) {
      return runWpCli(
        (path, init) => api.wpt(path, init),
        installationId,
        argv,
        signal,
      );
    },
  };
  return api;
}
