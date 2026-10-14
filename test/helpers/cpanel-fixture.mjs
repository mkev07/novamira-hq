// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Shared mock cPanel account for the cPanel contract tests. */

import { envCredential } from "../../dist/config/schema.js";
import { SecretValue } from "../../dist/credentials/resolve.js";
import { createHttpClient } from "../../dist/hosting/http-client.js";
import { createCpanelClientWith } from "../../dist/hosting/providers/cpanel.js";

export const TOKEN = "CPANELFAKETOKEN0000000000000000000000NOTREAL";
export const BASE = "https://cpanel.example.test:2083";
export const USER = "wptest";

/** Mock cPanel: `routes` maps "METHOD pathname" to a handler returning [status, body, contentType?]. */
export function cpanelFixture(routes = {}, options = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({
      method,
      url,
      authorization: new Headers(init.headers).get("authorization"),
      body: init.body,
    });
    if (options.networkError) throw options.networkError;
    const handler = routes[`${method} ${url.pathname}`];
    const [status, body, type] = handler
      ? await handler(url, init)
      : [404, { error: "unexpected", path: url.pathname }];
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
        headers: { "content-type": type ?? "application/json" },
      },
    );
  };
  const baseUrl = options.baseUrl ?? BASE;
  const context = {
    provider: "cpanel",
    providerLabel: "cPanel",
    profileName: "test",
    profile: {
      provider: "cpanel",
      credential: envCredential("CPANEL_API_TOKEN"),
      ...(options.missingUrl ? {} : { apiBaseUrl: baseUrl }),
      ...(options.missingUser ? {} : { companyId: options.user ?? USER }),
    },
    baseUrl,
    secret: new SecretValue(TOKEN, "env", "env:CPANEL_API_TOKEN"),
    credentialSource: "env:CPANEL_API_TOKEN",
    companyId: options.missingUser ? undefined : (options.user ?? USER),
    identity: options.missingUser ? undefined : (options.user ?? USER),
    tokenUrl: undefined,
    env: {},
    transferFetch: options.transferFetch ?? fetch,
    createHttpClient(overrides = {}) {
      return createHttpClient({
        baseUrl,
        providerLabel: "cPanel",
        fetch,
        retry: options.retry ?? { maxAttempts: 1 },
        ...overrides,
      });
    },
  };
  // Polling never really waits in tests; pass `sleep` to observe it.
  const client = createCpanelClientWith(context, {
    sleep: options.sleep ?? (async () => undefined),
  });
  return { client, calls, context };
}

export const ok = (data) => [
  200,
  {
    status: 1,
    errors: null,
    messages: null,
    warnings: null,
    metadata: {},
    data,
  },
];

export const DOMAINS_DATA = {
  main_domain: {
    domain: "wp.example.test",
    documentroot: "/home/wptest/public_html",
    homedir: "/home/wptest",
    type: "main_domain",
    user: "wptest",
  },
  addon_domains: [
    {
      domain: "plain.example.test",
      documentroot: "/home/wptest/plain",
      homedir: "/home/wptest",
      type: "addon_domain",
      user: "wptest",
    },
    {
      domain: "alias.example.test",
      documentroot: "/home/wptest/public_html",
      homedir: "/home/wptest",
      type: "addon_domain",
      user: "wptest",
    },
  ],
  sub_domains: [],
  parked_domains: [],
};
export const VERSION_PHP =
  "<?php\n$wp_version = '7.1.3';\n$wp_db_version = 60000;\n";
export const WP_HOME_URL = "https://wp.example.test";

export function fileman(files) {
  return {
    "GET /execute/Fileman/list_files": (url) => {
      const dir = url.searchParams.get("dir");
      return ok(
        (files[dir] ?? []).map((file) => ({
          file,
          type: "file",
          path: `/home/wptest/${dir}`,
        })),
      );
    },
    "GET /execute/Fileman/get_file_content": (url) =>
      url.searchParams.get("dir") === "public_html/wp-includes" &&
      url.searchParams.get("file") === "version.php"
        ? ok({ content: VERSION_PHP })
        : [
            200,
            { status: 0, errors: ["The file does not exist."], data: null },
          ],
  };
}

export const NO_TOOLKIT = {
  "GET /3rdparty/wpt/index.php/v1/installations": () => [
    404,
    "Not Found",
    "text/html",
  ],
};

/** The smallest body `downloadNovamiraArchive` accepts: the ZIP signature. */
export const ZIP = new Uint8Array([
  0x50,
  0x4b,
  0x03,
  0x04,
  ...new Array(60).fill(0),
]);
