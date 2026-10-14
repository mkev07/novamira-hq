// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The temporary cPanel session the installer path needs for its uploads:
 * `uapi_cpanel` cannot carry a multipart body, so WHM opens a session for the
 * account with `create_user_session`, HQ logs in once on the WHM host's cPanel
 * port and keeps only the `cpsession` cookie, and logs out afterwards.
 *
 * The session secret, the `/cpsess<N>` prefix and the cookie live only in this
 * closure. They are registered as secrets on every request that carries or
 * returns them, and no error, diagnostic or value built here contains them.
 */

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import { redactText } from "../../output/redact.js";
import type { ProviderClientContext } from "../factory.js";
import type { HttpClient } from "../http-client.js";
import {
  type CpanelApi,
  certificateFailure,
  uapiEnvelopeData,
} from "./cpanel-uapi.js";
import {
  type AccountApiOptions,
  permissionDenied,
  type WhmApi,
} from "./whm-api.js";

const UNUSABLE_SESSION =
  "WHM returned an unusable cPanel session. Nothing was uploaded.";
const LOGIN_FAILED =
  "cPanel did not open the temporary session. Nothing was uploaded.";
const SESSION_REFUSED =
  "The temporary cPanel session was refused. Nothing was installed.";
const SESSION_DENIED =
  "This WHM user cannot open cPanel sessions, which the temporary installer needs. Ask the server owner to give it the create-user-session privilege (WHM » Edit Reseller Nameservers and Privileges). Nothing was uploaded.";
const SESSION_CLOSED =
  "The temporary cPanel session is closed. Nothing was uploaded.";

/** Exactly the login path `create_user_session` returns. */
const LOGIN_PATH = /^(\/cpsess\d{1,20})\/login\/$/;
/** UAPI module and function names; anything else could change the path. */
const UAPI_NAME = /^[A-Za-z0-9_]{1,64}$/;
const LOGOUT_TIMEOUT_MS = 15_000;
/**
 * The login's own limit. It does not follow the caller's signal: a login cut
 * off mid-flight could leave a session open with no cookie to log it out.
 */
const LOGIN_TIMEOUT_MS = 15_000;
/** Each logout attempt's own limit, leaving room for the second one. */
const LOGOUT_ATTEMPT_MS = 7_000;

interface OpenSession {
  /** `/cpsess<N>`. */
  readonly prefix: string;
  /** The `cpsession` cookie's value. */
  readonly cookie: string;
}

/** The path prefix and session secret, or `undefined` for any other shape. */
function loginTarget(data: unknown):
  | {
      readonly pathname: string;
      readonly prefix: string;
      readonly session: string;
    }
  | undefined {
  const url = asRecord(data)?.url;
  if (typeof url !== "string") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  // The host is ignored on purpose: HQ never contacts it.
  const prefix = LOGIN_PATH.exec(parsed.pathname)?.[1];
  const pairs = [...parsed.searchParams];
  const [pair] = pairs;
  if (
    prefix === undefined ||
    pairs.length !== 1 ||
    pair?.[0] !== "session" ||
    pair[1] === ""
  )
    return undefined;
  return { pathname: parsed.pathname, prefix, session: pair[1] };
}

/** The `cpsession` value among the login's cookies; `""` when absent. */
function sessionCookie(headers: Headers): string {
  for (const entry of headers.getSetCookie()) {
    const pair = entry.split(";", 1)[0] ?? "";
    const split = pair.indexOf("=");
    if (split > 0 && pair.slice(0, split).trim() === "cpsession")
      return pair.slice(split + 1).trim();
  }
  return "";
}

/**
 * An error safe to hand back: the HTTP client already redacted the registered
 * secrets from its message and details, and the cause (a transport error that
 * may describe the request) is dropped. Uploads are never retried, so none is
 * marked retryable.
 */
function sanitized(error: unknown): CliError {
  if (error instanceof CliError)
    return new CliError(error.code, error.message, {
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  return new CliError(
    "network_error",
    "The temporary cPanel session request failed. Nothing was installed.",
  );
}

/**
 * The cPanel port did not answer: a transport failure, a timeout or a
 * certificate HQ cannot trust, as opposed to cPanel answering and refusing.
 */
function unreachable(error: unknown): boolean {
  return (
    certificateFailure(error) ||
    (error instanceof CliError &&
      error.details?.status === undefined &&
      (error.code === "network_error" || error.code === "timeout"))
  );
}

/** Names the cPanel origin (never a path) and what it needs. */
function unreachableError(cpanelOrigin: string): CliError {
  return new CliError(
    "network_error",
    `Novamira HQ could not reach cPanel at ${cpanelOrigin} to upload the installer. Port 2083 must be reachable from this computer with a valid certificate. Nothing was uploaded.`,
  );
}

/** HTTP 401 or 403 as recorded by the shared HTTP client. */
function refused(error: unknown): boolean {
  const status = error instanceof CliError ? error.details?.status : undefined;
  return status === 401 || status === 403;
}

/**
 * `uploads` for `createAccountApi`: the first `multipart` opens the session,
 * later ones reuse it, `close()` logs it out (best effort) and forgets it.
 */
export function sessionUploads(
  context: ProviderClientContext,
  whm: WhmApi,
): NonNullable<AccountApiOptions["uploads"]> {
  return (user) => {
    // No `auth`: nothing on this client can carry the WHM token.
    const http: HttpClient = context.createHttpClient({
      baseUrl: whm.cpanelOrigin,
      retry: { maxAttempts: 1 },
    });
    let opening: Promise<OpenSession> | undefined;
    let closed = false;
    const isClosed = (): boolean => closed;

    async function open(signal: AbortSignal | undefined): Promise<OpenSession> {
      let created: unknown;
      try {
        created = await whm.call(
          "create_user_session",
          { user, service: "cpaneld" },
          { signal },
        );
      } catch (error) {
        if (permissionDenied(error))
          throw new CliError("provider_error", SESSION_DENIED);
        throw error;
      }
      const target = loginTarget(created);
      if (target === undefined)
        throw new CliError("provider_error", UNUSABLE_SESSION);
      const { pathname, prefix, session } = target;
      let cookie: string;
      try {
        const response = await http.request({
          path: `${whm.cpanelOrigin}${pathname}`,
          query: { session },
          redirect: "return",
          anonymous: true,
          secrets: [session, pathname, prefix, prefix.slice(1)],
          // Not the caller's signal: see LOGIN_TIMEOUT_MS. A cancellation is
          // honoured once the cookie is known, so `close()` can log it out.
          signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
        });
        cookie =
          response.status >= 300 && response.status < 400
            ? sessionCookie(response.headers)
            : "";
      } catch (error) {
        signal?.throwIfAborted();
        if (unreachable(error)) throw unreachableError(whm.cpanelOrigin);
        throw new CliError("provider_error", LOGIN_FAILED);
      }
      if (cookie === "") throw new CliError("provider_error", LOGIN_FAILED);
      return { prefix, cookie };
    }

    function secretsOf(state: OpenSession): string[] {
      return [
        state.cookie,
        `cpsession=${state.cookie}`,
        state.prefix,
        state.prefix.slice(1),
      ];
    }

    const multipart: CpanelApi["uapiMultipart"] = async (
      module,
      fn,
      body,
      options = {},
    ) => {
      if (!UAPI_NAME.test(module) || !UAPI_NAME.test(fn))
        throw new Error("A UAPI module or function name is invalid.");
      if (closed) throw new CliError("provider_error", SESSION_CLOSED);
      const { signal, timeoutMs } = options;
      opening ??= open(signal);
      const state = await opening;
      // `close()` may have run while the session was opening; it logs out.
      if (isClosed()) throw new CliError("provider_error", SESSION_CLOSED);
      // A cancellation during the login lands here, after the session opened.
      signal?.throwIfAborted();
      let response;
      try {
        response = await http.request({
          path: `${whm.cpanelOrigin}${state.prefix}/execute/${module}/${fn}`,
          method: "POST",
          body,
          headers: { cookie: `cpsession=${state.cookie}` },
          secrets: secretsOf(state),
          anonymous: true,
          idempotent: false,
          ...(signal === undefined ? {} : { signal }),
          ...(timeoutMs === undefined
            ? {}
            : { timeoutMs, totalTimeoutMs: timeoutMs }),
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (refused(error))
          throw new CliError("provider_error", SESSION_REFUSED);
        if (unreachable(error)) throw unreachableError(whm.cpanelOrigin);
        throw sanitized(error);
      }
      try {
        return uapiEnvelopeData(response.data, module, fn);
      } catch (error) {
        // cPanel's own error text is quoted; it must not echo the session.
        if (!(error instanceof CliError)) throw error;
        throw new CliError(
          error.code,
          redactText(error.message, secretsOf(state)),
        );
      }
    };

    async function close(): Promise<void> {
      if (closed) return;
      closed = true;
      const pending = opening;
      opening = undefined;
      let state: OpenSession;
      try {
        if (pending === undefined) return;
        state = await pending;
      } catch {
        // A session that never opened has no cookie to log out.
        return;
      }
      try {
        await http.request({
          path: `${whm.cpanelOrigin}${state.prefix}/logout/`,
          query: { locale: "en" },
          headers: { cookie: `cpsession=${state.cookie}` },
          secrets: secretsOf(state),
          anonymous: true,
          redirect: "return",
          // cpsrvd closes the idle keep-alive socket while the installer runs
          // through WHM, and the first logout can land on that dead pooled
          // connection ("other side closed"). One more attempt, on a new
          // connection, reaches cPanel. Transport failures are retryable; the
          // HTML answer is not (it is a 200 that is not JSON).
          idempotent: true,
          retry: { maxAttempts: 2 },
          signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
          timeoutMs: LOGOUT_ATTEMPT_MS,
          totalTimeoutMs: LOGOUT_TIMEOUT_MS,
        });
      } catch {
        // Best effort: the logout page is HTML (not JSON, so it lands here as
        // an error while the logout worked), and the session expires anyway.
      }
    }

    return { multipart, close };
  };
}
