// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Shared mock WHM server for the WHM contract tests. */

import { envCredential } from "../../dist/config/schema.js";
import { SecretValue } from "../../dist/credentials/resolve.js";
import { createHttpClient } from "../../dist/hosting/http-client.js";
import { createWhmClientWith } from "../../dist/hosting/providers/whm.js";

export const TOKEN = "WHMFAKETOKEN00000000000000000000000NOTREAL";
export const BASE = "https://whm.example.test:2087";
export const CPANEL = "https://whm.example.test:2083";

/**
 * Mock WHM: `routes` maps "METHOD origin+pathname" (for example
 * `GET https://whm.example.test:2087/json-api/listaccts`) to a handler
 * returning [status, body, contentType?, headers?], `headers` being extra
 * [name, value] pairs (repeatable, for `set-cookie`). The origin is part of
 * the key so a test can tell WHM (:2087) from a cPanel account call (:2083).
 * `options.onDiagnostic` receives every HTTP client diagnostic; `options.http`
 * adds HTTP client defaults (for example a short `timeoutMs`).
 */
export function whmFixture(routes = {}, options = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const sent = new Headers(init.headers);
    calls.push({
      method,
      url,
      authorization: sent.get("authorization"),
      cookie: sent.get("cookie"),
      body: init.body,
      redirect: init.redirect,
    });
    if (options.networkError) throw options.networkError;
    const handler = routes[`${method} ${url.origin}${url.pathname}`];
    const [status, body, type, extra = []] = handler
      ? await handler(url, init)
      : [404, { error: "unexpected", path: `${url.origin}${url.pathname}` }];
    const headers = new Headers({ "content-type": type ?? "application/json" });
    for (const [name, value] of extra) headers.append(name, value);
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status, headers },
    );
  };
  const baseUrl = options.baseUrl ?? BASE;
  const identity = options.missingUser ? undefined : (options.user ?? "root");
  const context = {
    provider: "whm",
    providerLabel: "WHM",
    profileName: "test",
    profile: {
      provider: "whm",
      credential: envCredential("WHM_API_TOKEN"),
      ...(options.missingUrl ? {} : { apiBaseUrl: baseUrl }),
      ...(identity === undefined ? {} : { companyId: identity }),
    },
    baseUrl,
    secret: new SecretValue(TOKEN, "env", "env:WHM_API_TOKEN"),
    credentialSource: "env:WHM_API_TOKEN",
    companyId: identity,
    identity,
    tokenUrl: undefined,
    env: {},
    transferFetch: options.transferFetch ?? fetch,
    createHttpClient(overrides = {}) {
      return createHttpClient({
        baseUrl,
        providerLabel: "WHM",
        fetch,
        retry: options.retry ?? { maxAttempts: 1 },
        ...(options.onDiagnostic === undefined
          ? {}
          : { onDiagnostic: options.onDiagnostic }),
        // Shared HTTP defaults such as `timeoutMs`, under the client's own.
        ...options.http,
        ...overrides,
      });
    },
  };
  // Polling never really waits in tests; pass `sleep` to observe it.
  const client = createWhmClientWith(context, {
    sleep: options.sleep ?? (async () => undefined),
  });
  return { client, calls, context };
}

export const whmOk = (command, data) => [
  200,
  { metadata: { command, result: 1, reason: "OK", version: 1 }, data },
];

export const whmFail = (command, reason) => [
  200,
  { metadata: { command, result: 0, reason, version: 1 } },
];
