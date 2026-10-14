// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { CPANEL_CAPABILITIES } from "../dist/hosting/providers/cpanel.js";
import { renderHtml } from "../dist/web/html.js";
import { renderBackupCreate } from "../dist/web/views/backup-create.js";
import {
  createAccountApi,
  createWhmApi,
  createWhmToolkit,
} from "../dist/hosting/providers/whm-api.js";
import {
  parseWhmId,
  WHM_CAPABILITIES,
  whmSiteId,
} from "../dist/hosting/providers/whm.js";
import {
  BASE,
  CPANEL,
  TOKEN,
  whmFail,
  whmFixture,
  whmOk,
} from "./helpers/whm-fixture.mjs";

const VALID = {
  [`GET ${BASE}/json-api/listaccts`]: () => whmOk("listaccts", { acct: [] }),
};

test("WHM validates a root token with listaccts alone, sending only the whm header", async () => {
  const { client, calls } = whmFixture(VALID);
  assert.deepEqual(await client.validate(), {
    provider: "whm",
    status: "active",
    companyId: "root",
    credential: "env:WHM_API_TOKEN",
  });
  assert.deepEqual(
    calls.map((c) => c.url.pathname),
    ["/json-api/listaccts"],
  );
  for (const call of calls) {
    assert.equal(call.authorization, `whm root:${TOKEN}`);
    assert.equal(call.url.searchParams.get("api.version"), "1");
    assert.ok(!call.url.href.includes(TOKEN));
    assert.equal(call.cookie, null);
  }
  assert.equal(calls[0].url.searchParams.get("want"), "user");
});

test("WHM treats a missing user as root", async () => {
  const { client, calls } = whmFixture(VALID, { missingUser: true });
  assert.equal((await client.validate()).companyId, "root");
  assert.equal(calls[0].authorization, `whm root:${TOKEN}`);
});

test("WHM validates a reseller token as that reseller", async () => {
  const { client, calls } = whmFixture(VALID, { user: "wpres" });
  assert.deepEqual(await client.validate(), {
    provider: "whm",
    status: "active",
    companyId: "wpres",
    credential: "env:WHM_API_TOKEN",
  });
  assert.deepEqual(
    calls.map((c) => [c.url.pathname, c.authorization]),
    [["/json-api/listaccts", `whm wpres:${TOKEN}`]],
  );
});

test("WHM names the privilege when the user may not list accounts", async () => {
  const { client, calls } = whmFixture(
    {
      [`GET ${BASE}/json-api/listaccts`]: () =>
        whmFail(
          "listaccts",
          "Permission denied: You do not have the required privileges to run “listaccts”.",
        ),
    },
    { user: "wpres" },
  );
  await assert.rejects(client.validate(), {
    code: "credential_invalid",
    message:
      "This WHM user cannot list accounts. Ask the server owner to give it the list-accts privilege (WHM » Edit Reseller Nameservers and Privileges).",
  });
  await assert.rejects(client.listSites(), {
    code: "credential_invalid",
    message: /cannot list accounts/,
  });
  assert.equal(calls.length, 2);
});

test("only a reason that starts with Permission denied is a missing privilege", async () => {
  const { client } = whmFixture({
    [`GET ${BASE}/json-api/listaccts`]: () =>
      whmFail("listaccts", "Account list unavailable: Permission denied"),
  });
  await assert.rejects(client.validate(), { code: "provider_error" });
});

test("WHM maps 403 to credential_invalid and a failed WHM call to provider_error", async () => {
  const denied = whmFixture({
    [`GET ${BASE}/json-api/listaccts`]: () => [
      403,
      "Access denied",
      "text/plain",
    ],
  });
  await assert.rejects(denied.client.validate(), {
    code: "credential_invalid",
    message:
      "WHM rejected the API token. Check that the WHM user is the one that created the token in WHM » Development » Manage API Tokens and that the token has not been revoked.",
  });
  const failed = whmFixture({
    ...VALID,
    [`GET ${BASE}/json-api/listaccts`]: () =>
      whmFail("listaccts", "Something broke"),
  });
  await assert.rejects(failed.client.validate(), {
    code: "provider_error",
    message: /listaccts.*Something broke/,
  });
});

test("WHM bounds the failure reason and falls back when there is none", async () => {
  const long = whmFixture({
    ...VALID,
    [`GET ${BASE}/json-api/listaccts`]: () =>
      whmFail("listaccts", "x".repeat(1000)),
  });
  await assert.rejects(long.client.validate(), (error) => {
    assert.equal(error.code, "provider_error");
    assert.ok(error.message.length < 400);
    return true;
  });
  const silent = whmFixture({
    ...VALID,
    [`GET ${BASE}/json-api/listaccts`]: () => [
      200,
      { metadata: { command: "listaccts", result: 0 } },
    ],
  });
  await assert.rejects(silent.client.validate(), {
    code: "provider_error",
    message: "WHM listaccts failed.",
  });
});

test("WHM says when the address does not answer as WHM", async () => {
  const notFound = whmFixture({
    [`GET ${BASE}/json-api/listaccts`]: () => [404, "Not Found", "text/html"],
  });
  const page = whmFixture({
    [`GET ${BASE}/json-api/listaccts`]: () => [
      200,
      "<html>login</html>",
      "text/html",
    ],
  });
  const noEnvelope = whmFixture({
    [`GET ${BASE}/json-api/listaccts`]: () => [200, { hello: "world" }],
  });
  for (const { client } of [notFound, page, noEnvelope])
    await assert.rejects(client.validate(), {
      code: "provider_error",
      message: /did not answer as WHM/,
    });
});

test("WHM names the certificate problem", async () => {
  const error = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
  });
  const { client } = whmFixture({}, { networkError: error });
  await assert.rejects(client.validate(), {
    code: "network_error",
    message: /no valid certificate/,
  });
});

test("WHM requires an HTTPS root URL and a user name that fits the header", () => {
  for (const baseUrl of [
    "http://whm.example.test:2087",
    "https://u:p@whm.example.test:2087",
    "https://whm.example.test:2087/x",
    "https://whm.example.test:2087/?a=1",
  ])
    assert.throws(() => whmFixture({}, { baseUrl }), { code: "config_error" });
  for (const baseUrl of [
    "https://whm.example.test:2082",
    "https://whm.example.test:2083",
  ])
    assert.throws(() => whmFixture({}, { baseUrl }), {
      code: "config_error",
      message:
        "WHM needs its own address, usually on port 2087, not the cPanel port.",
    });
  for (const user of ["Root", "res:ller", "res ller", "1reseller", ""])
    assert.throws(() => whmFixture({}, { user }), {
      code: "config_error",
      message:
        "Enter the WHM user that created the API token: root or a reseller user name.",
    });
  assert.doesNotThrow(() => whmFixture({}, { user: "reseller1" }));
});

test("WHM without a configured URL makes no request", async () => {
  const { client, calls } = whmFixture(VALID, { missingUrl: true });
  await assert.rejects(client.validate(), { code: "config_error" });
  assert.deepEqual(calls, []);
});

test("WHM publishes the cPanel capabilities with its own sites.list note", async () => {
  const { client, calls } = whmFixture(VALID);
  const capabilities = await client.read({ kind: "capabilities" });
  const byName = Object.fromEntries(
    capabilities.map((capability) => [capability.name, capability]),
  );
  assert.equal(byName["providers.validate"].supported, true);
  assert.equal(byName["sites.list"].supported, true);
  assert.match(byName["sites.list"].notes, /every cPanel account/);
  assert.equal(byName["backups.restore"].supported, false);
  // The table is cPanel's, with only the sites.list note reworded.
  assert.deepEqual(
    capabilities.filter(({ name }) => name !== "sites.list"),
    CPANEL_CAPABILITIES.filter(({ name }) => name !== "sites.list"),
  );
  assert.deepEqual(
    capabilities.map(({ name }) => name),
    CPANEL_CAPABILITIES.map(({ name }) => name),
  );
  assert.equal(
    byName["cache.clear"].notes,
    "Not available through the cPanel user API",
  );
  assert.deepEqual(calls, []);
});

const proxy = (uapi) => whmOk("uapi_cpanel", { uapi });
const uapiOk = (data) => ({
  status: 1,
  errors: null,
  messages: null,
  warnings: null,
  data,
});
const INSTALLATIONS = `${BASE}/cgi/wpt/index.php/v1/installations`;
const installation = (id, path) => ({
  id,
  url: `https://site${String(id)}.test`,
  path,
  version: "6.9",
  status: { alive: true, multisite: false },
});

const FEATURE_ROUTE = `GET ${BASE}/json-api/verify_user_has_feature`;
/** verify_user_has_feature: every account has WP Toolkit unless `answers` says otherwise. */
const feature =
  (answers = {}, seen = []) =>
  (url) => {
    assert.equal(url.searchParams.get("feature"), "wp-toolkit");
    const user = url.searchParams.get("user");
    seen.push(user);
    const answer = user in answers ? answers[user] : 1;
    return typeof answer === "function"
      ? answer()
      : whmOk("verify_user_has_feature", {
          has_feature: answer,
          query_feature: "wp-toolkit",
        });
  };

function accountApi(routes, options, accountOptions) {
  const fixture = whmFixture(routes, options);
  const whm = createWhmApi(fixture.context);
  const toolkit = createWhmToolkit(fixture.context, whm);
  return {
    ...fixture,
    toolkit,
    api: createAccountApi(whm, toolkit, "wptest", accountOptions),
  };
}

test("account UAPI calls go through uapi_cpanel with the account user", async () => {
  const { context, calls } = whmFixture({
    [`GET ${BASE}/json-api/uapi_cpanel`]: (url) => {
      assert.equal(url.searchParams.get("cpanel.user"), "wptest");
      assert.equal(url.searchParams.get("cpanel.module"), "Fileman");
      assert.equal(url.searchParams.get("cpanel.function"), "list_files");
      assert.equal(url.searchParams.get("dir"), "public_html");
      return proxy(uapiOk([{ file: "wp-config.php" }]));
    },
  });
  const whm = createWhmApi(context);
  const api = createAccountApi(whm, createWhmToolkit(context, whm), "wptest");
  assert.equal(api.username, "wptest");
  assert.equal(api.origin, CPANEL);
  assert.deepEqual(
    await api.uapi("Fileman", "list_files", { dir: "public_html" }),
    [{ file: "wp-config.php" }],
  );
  assert.equal(calls[0].authorization, `whm root:${TOKEN}`);
});

test("account UAPI writes are POST forms and the account fields cannot be overridden by parameters", async () => {
  const { api, calls } = accountApi({
    [`POST ${BASE}/json-api/uapi_cpanel`]: () => proxy(uapiOk({ ok: 1 })),
  });
  assert.deepEqual(
    await api.uapi(
      "Fileman",
      "rename",
      { "cpanel.user": "someone", from: "a", to: "b" },
      { method: "POST" },
    ),
    { ok: 1 },
  );
  const form = new URLSearchParams(String(calls[0].body));
  assert.equal(form.get("cpanel.user"), "wptest");
  assert.equal(form.get("cpanel.module"), "Fileman");
  assert.equal(form.get("cpanel.function"), "rename");
  assert.equal(form.get("from"), "a");
  assert.equal(calls[0].url.search, "");
});

test("an inner UAPI failure keeps the cPanel message; a missing account is not_found", async () => {
  const { context } = whmFixture({
    [`GET ${BASE}/json-api/uapi_cpanel`]: (url) =>
      url.searchParams.get("cpanel.user") === "gone"
        ? whmFail(
            "uapi_cpanel",
            "API failure: (XID abc) You do not have a user named \u201cgone\u201d.",
          )
        : proxy({
            status: 0,
            errors: ["The directory \u201cx\u201d does not exist."],
            data: null,
          }),
  });
  const whm = createWhmApi(context);
  const toolkit = createWhmToolkit(context, whm);
  await assert.rejects(
    createAccountApi(whm, toolkit, "wptest").uapi("Fileman", "list_files", {
      dir: "x",
    }),
    {
      code: "provider_error",
      message: /Fileman::list_files failed: The directory/,
    },
  );
  await assert.rejects(
    createAccountApi(whm, toolkit, "gone").uapi("DomainInfo", "domains_data"),
    {
      code: "not_found",
      message:
        "The cPanel account gone is suspended, no longer exists on this server, or is not managed by this WHM user.",
    },
  );
});

test("other WHM failures and unreadable proxy answers stay provider errors", async () => {
  let answer = whmFail("uapi_cpanel", "API failure: the proxy is busy");
  const { api } = accountApi({
    [`GET ${BASE}/json-api/uapi_cpanel`]: () => answer,
  });
  await assert.rejects(api.uapi("Fileman", "list_files"), {
    code: "provider_error",
    message: /proxy is busy/,
  });
  answer = whmOk("uapi_cpanel", {});
  await assert.rejects(api.uapi("Fileman", "list_files"), {
    code: "provider_error",
    message: "cPanel returned an unexpected response; check the panel address.",
  });
});

test("WHM-level WP Toolkit is listed once and split by home directory", async () => {
  let lists = 0;
  const { context } = whmFixture({
    [FEATURE_ROUTE]: feature(),
    [`GET ${INSTALLATIONS}`]: () => {
      lists += 1;
      return [
        200,
        [
          installation(1, "/home/ab/public_html"),
          installation(2, "/home/abc/public_html"),
          installation(3, "/home/ab"),
          installation(4, "/home/ab/../abc/public_html"),
        ],
      ];
    },
    [`GET ${BASE}/json-api/uapi_cpanel`]: (url) =>
      proxy(uapiOk({ home: `/home/${url.searchParams.get("cpanel.user")}` })),
  });
  const whm = createWhmApi(context);
  const toolkit = createWhmToolkit(context, whm);
  assert.deepEqual(
    (await createAccountApi(whm, toolkit, "ab").toolkitInstallations()).map(
      (i) => i.id,
    ),
    [1, 3],
  );
  assert.deepEqual(
    (await createAccountApi(whm, toolkit, "abc").toolkitInstallations()).map(
      (i) => i.id,
    ),
    [2],
  );
  assert.equal(lists, 1);
});

test("the account home directory is read once per account API and must be a safe absolute path", async () => {
  let homes = 0;
  let home = "/home/wptest";
  const { api } = accountApi({
    [FEATURE_ROUTE]: feature(),
    [`GET ${INSTALLATIONS}`]: () => [200, [installation(1, "/home/wptest/x")]],
    [`GET ${BASE}/json-api/uapi_cpanel`]: (url) => {
      assert.equal(url.searchParams.get("cpanel.module"), "Variables");
      assert.equal(
        url.searchParams.get("cpanel.function"),
        "get_user_information",
      );
      assert.equal(url.searchParams.get("name"), "home");
      homes += 1;
      return proxy(uapiOk({ home }));
    },
  });
  await api.toolkitInstallations();
  await api.toolkitInstallations();
  assert.equal(homes, 1);
  for (const bad of ["relative/home", "/home/../etc", "", "/"]) {
    home = bad;
    const fresh = accountApi({
      [FEATURE_ROUTE]: feature(),
      [`GET ${INSTALLATIONS}`]: () => [200, []],
      [`GET ${BASE}/json-api/uapi_cpanel`]: () => proxy(uapiOk({ home: bad })),
    });
    await assert.rejects(fresh.api.toolkitInstallations(), {
      code: "provider_error",
      message: "cPanel returned an invalid home directory.",
    });
  }
});

test("no WHM WP Toolkit (401, 403, 404) or an invalid list means per-account discovery", async () => {
  for (const answer of [
    [404, "Not Found", "text/html"],
    [401, "Login", "text/html"],
    [403, { error: "forbidden" }],
    [200, { meta: { status: 500 } }],
    [200, "<html>login</html>", "text/html"],
    [200, [{ id: "x" }]],
  ]) {
    const { context } = whmFixture({ [`GET ${INSTALLATIONS}`]: () => answer });
    const whm = createWhmApi(context);
    assert.equal(
      await createWhmToolkit(context, whm).installations(),
      undefined,
    );
  }
  const { api, calls } = accountApi({
    [FEATURE_ROUTE]: feature(),
    [`GET ${INSTALLATIONS}`]: () => [404, "Not Found", "text/html"],
  });
  assert.equal(await api.toolkitInstallations(), undefined);
  assert.deepEqual(
    calls.map((c) => c.url.pathname),
    [
      "/json-api/verify_user_has_feature",
      "/cgi/wpt/index.php/v1/installations",
    ],
  );
});

test("an account without the wp-toolkit feature has no toolkit and costs no list or home request", async () => {
  for (const answer of [0, "0"]) {
    const { api, calls } = accountApi({
      [FEATURE_ROUTE]: feature({ wptest: answer }),
    });
    assert.equal(await api.toolkitInstallations(), undefined);
    assert.equal(await api.toolkitInstallations(), undefined);
    assert.deepEqual(
      calls.map((c) => c.url.pathname),
      ["/json-api/verify_user_has_feature"],
    );
    assert.equal(calls[0].url.searchParams.get("user"), "wptest");
    assert.equal(calls[0].authorization, `whm root:${TOKEN}`);
  }
});

test("an account with the feature gets its installations; the feature is asked once per account API", async () => {
  const seen = [];
  const { api } = accountApi({
    [FEATURE_ROUTE]: feature({ wptest: "1" }, seen),
    [`GET ${INSTALLATIONS}`]: () => [
      200,
      [
        installation(1, "/home/wptest/public_html"),
        installation(2, "/home/other/public_html"),
      ],
    ],
    [`GET ${BASE}/json-api/uapi_cpanel`]: () =>
      proxy(uapiOk({ home: "/home/wptest" })),
  });
  assert.deepEqual(
    (await api.toolkitInstallations()).map((i) => i.id),
    [1],
  );
  assert.deepEqual(
    (await api.toolkitInstallations()).map((i) => i.id),
    [1],
  );
  assert.deepEqual(seen, ["wptest"]);
});

test("accounts with and without the feature share one server list fetched at most once", async () => {
  let lists = 0;
  const seen = [];
  const { context } = whmFixture({
    [FEATURE_ROUTE]: feature({ wpnotk: 0 }, seen),
    [`GET ${INSTALLATIONS}`]: () => {
      lists += 1;
      return [
        200,
        [
          installation(1, "/home/wptest/public_html"),
          installation(2, "/home/wpnotk/public_html"),
        ],
      ];
    },
    [`GET ${BASE}/json-api/uapi_cpanel`]: (url) =>
      proxy(uapiOk({ home: `/home/${url.searchParams.get("cpanel.user")}` })),
  });
  const whm = createWhmApi(context);
  const toolkit = createWhmToolkit(context, whm);
  const without = createAccountApi(whm, toolkit, "wpnotk");
  const withIt = createAccountApi(whm, toolkit, "wptest");
  assert.equal(await without.toolkitInstallations(), undefined);
  assert.equal(
    lists,
    0,
    "the account without the feature never asks for the list",
  );
  assert.deepEqual(
    (await withIt.toolkitInstallations()).map((i) => i.id),
    [1],
  );
  assert.equal(await without.toolkitInstallations(), undefined);
  assert.equal(lists, 1);
  assert.deepEqual(seen, ["wpnotk", "wptest"]);
});

test("an invalid feature answer is a provider error, is not remembered, and reads nothing else", async () => {
  for (const answer of [
    { has_feature: 2 },
    { has_feature: "yes" },
    { has_feature: null },
    {},
    [],
  ]) {
    let current = answer;
    const { api, calls } = accountApi({
      [FEATURE_ROUTE]: () => whmOk("verify_user_has_feature", current),
      [`GET ${INSTALLATIONS}`]: () => [200, []],
      [`GET ${BASE}/json-api/uapi_cpanel`]: () =>
        proxy(uapiOk({ home: "/home/wptest" })),
    });
    await assert.rejects(api.toolkitInstallations(), {
      code: "provider_error",
      message: "WHM returned an invalid feature answer.",
    });
    assert.equal(calls.length, 1);
    current = { has_feature: 1 };
    assert.deepEqual(await api.toolkitInstallations(), []);
  }
});

test("an unknown account on the feature check is the same not_found as for UAPI", async () => {
  const { api } = accountApi({
    [FEATURE_ROUTE]: () =>
      whmFail(
        "verify_user_has_feature",
        "API failure: (XID abc) You do not have a user named \u201cwptest\u201d.",
      ),
  });
  await assert.rejects(api.toolkitInstallations(), {
    code: "not_found",
    message:
      "The cPanel account wptest is suspended, no longer exists on this server, or is not managed by this WHM user.",
  });
});

test("other failures of the feature check keep their kind", async () => {
  const { api } = accountApi({
    [FEATURE_ROUTE]: () => [403, { error: "forbidden" }],
  });
  await assert.rejects(api.toolkitInstallations(), {
    code: "credential_invalid",
  });
});

test("WHM requests refuse a path that does not start with a slash and send nothing", async () => {
  const { context, calls } = whmFixture({});
  const whm = createWhmApi(context);
  for (const path of ["@evil.test/x", "cgi/wpt", ""])
    await assert.rejects(whm.request(path), {
      message: "A WHM request path must start with /.",
    });
  assert.deepEqual(calls, []);
});

test("WHM-level WP Toolkit sends the WHM token and never a cookie", async () => {
  const { toolkit, calls } = accountApi({
    [`GET ${INSTALLATIONS}`]: () => [200, []],
  });
  assert.deepEqual(await toolkit.installations(), []);
  assert.equal(calls[0].authorization, `whm root:${TOKEN}`);
  assert.equal(calls[0].cookie, null);
});

test("a rejected credential on a WP Toolkit path other than the list is credential_invalid", async () => {
  const { api } = accountApi({
    [`POST ${BASE}/cgi/wpt/index.php/v1/installations/7/features/wp-cli`]:
      () => [403, { error: "forbidden" }],
  });
  await assert.rejects(
    api.wpt("/v1/installations/7/features/wp-cli", {
      method: "POST",
      json: {},
    }),
    {
      code: "credential_invalid",
    },
  );
  await assert.rejects(api.wpCli(7, ["option", "get", "home"]), {
    code: "credential_invalid",
  });
});

test("WP-CLI runs through the WHM-level endpoint with the global installation id", async () => {
  const { api, calls } = accountApi({
    [`POST ${BASE}/cgi/wpt/index.php/v1/installations/7/features/wp-cli`]:
      () => [200, { exitCode: 0, stdout: "https://wp.test\n", stderr: "" }],
  });
  assert.equal(
    await api.wpCli(7, ["option", "get", "home"]),
    "https://wp.test\n",
  );
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    command: ["option", "get", "home"],
    env: null,
  });
  assert.equal(calls[0].authorization, `whm root:${TOKEN}`);
});

test("WP-CLI answers that are not confirmed name the endpoint, not WHM", async () => {
  const { api } = accountApi({
    [`POST ${BASE}/cgi/wpt/index.php/v1/installations/7/features/wp-cli`]:
      () => [404, { error: "no such installation" }],
    [`POST ${BASE}/cgi/wpt/index.php/v1/installations/8/features/wp-cli`]:
      () => [200, { exitCode: 1, stdout: "", stderr: "boom" }],
  });
  for (const id of [7, 8])
    await assert.rejects(api.wpCli(id, ["option", "get", "home"]), {
      code: "provider_error",
      message: /WP Toolkit did not confirm the command/,
    });
});

test("account uploads are refused until a session channel exists", async () => {
  const { context } = whmFixture({});
  const whm = createWhmApi(context);
  const api = createAccountApi(whm, createWhmToolkit(context, whm), "wptest");
  await assert.rejects(
    api.uapiMultipart("Fileman", "upload_files", {
      kind: "multipart",
      fields: {},
      files: [],
    }),
    {
      code: "provider_error",
      message: "File uploads through WHM are not available.",
    },
  );
  await api.close();
});

test("account uploads open one channel for the account, reuse it, and close it once", async () => {
  const opened = [];
  const sent = [];
  let closed = 0;
  const { api } = accountApi({}, undefined, {
    uploads: (user) => {
      opened.push(user);
      return {
        multipart: async (module, fn, body) => {
          sent.push([module, fn, body.files.length]);
          return { succeeded: 1 };
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  });
  const body = { kind: "multipart", fields: {}, files: [] };
  assert.deepEqual(await api.uapiMultipart("Fileman", "upload_files", body), {
    succeeded: 1,
  });
  await api.uapiMultipart("Fileman", "upload_files", body);
  assert.deepEqual(opened, ["wptest"]);
  assert.equal(sent.length, 2);
  await api.close();
  await api.close();
  assert.equal(closed, 1);
  await assert.rejects(api.uapiMultipart("Fileman", "upload_files", body), {
    code: "provider_error",
  });
  assert.deepEqual(opened, ["wptest"]);
});

test("closing before any upload opens nothing, and later uploads are refused", async () => {
  let opened = 0;
  const { api } = accountApi({}, undefined, {
    uploads: () => {
      opened += 1;
      return { multipart: async () => ({}), close: async () => undefined };
    },
  });
  await api.close();
  await assert.rejects(
    api.uapiMultipart("Fileman", "upload_files", {
      kind: "multipart",
      fields: {},
      files: [],
    }),
    { code: "provider_error" },
  );
  assert.equal(opened, 0);
});

test("closing never throws, even when the session channel fails to close", async () => {
  const { api } = accountApi({}, undefined, {
    uploads: () => ({
      multipart: async () => ({}),
      close: async () => {
        throw new Error("logout failed");
      },
    }),
  });
  await api.uapiMultipart("Fileman", "upload_files", {
    kind: "multipart",
    fields: {},
    files: [],
  });
  await api.close();
});

const LISTACCTS = `GET ${BASE}/json-api/listaccts`;
const UAPI = `GET ${BASE}/json-api/uapi_cpanel`;
const fnOf = (url) =>
  `${url.searchParams.get("cpanel.module")}::${url.searchParams.get("cpanel.function")}`;
const proxied = (calls, fn) =>
  calls.filter(
    (call) =>
      call.url.pathname === "/json-api/uapi_cpanel" &&
      (fn === undefined || fnOf(call.url) === fn),
  );
const installationRequests = (calls) =>
  calls.filter(
    (call) => call.url.pathname === "/cgi/wpt/index.php/v1/installations",
  );

const POST_UAPI = `POST ${BASE}/json-api/uapi_cpanel`;

/**
 * Mock server. accounts: { user: { domains: [{ domain, documentroot }],
 * files: { "<dir>": ["wp-config.php" | { file, size, mtime }] | () => [...] },
 * errors?: ["log line"], suspended?: 1, wpt?: false } }; the first domain is
 * the main one, the others are addon domains. A POST to `uapi_cpanel` starts
 * the account backup.
 */
function server(accounts, { toolkit } = {}) {
  return {
    [POST_UAPI]: (url, init) => {
      const form = new URLSearchParams(String(init.body));
      const user = form.get("cpanel.user");
      if (!accounts[user])
        return whmFail(
          "uapi_cpanel",
          `API failure: (XID x) You do not have a user named “${user}”.`,
        );
      const fn = `${form.get("cpanel.module")}::${form.get("cpanel.function")}`;
      return fn === "Backup::fullbackup_to_homedir"
        ? proxy(uapiOk({ pid: "83248" }))
        : proxy({ status: 0, errors: [`unexpected ${fn}`], data: null });
    },
    [LISTACCTS]: () =>
      whmOk("listaccts", {
        acct: Object.entries(accounts).map(([user, account]) => ({
          user,
          domain: account.domains[0].domain,
          suspended: account.suspended ?? 0,
        })),
      }),
    [`GET ${INSTALLATIONS}`]: () =>
      toolkit ? [200, toolkit] : [404, "Not Found", "text/html"],
    [FEATURE_ROUTE]: (url) => {
      const account = accounts[url.searchParams.get("user")];
      return account
        ? whmOk("verify_user_has_feature", {
            has_feature: account.wpt === false ? 0 : 1,
            query_feature: "wp-toolkit",
          })
        : whmFail(
            "verify_user_has_feature",
            "API failure: (XID x) You do not have a user named “x”.",
          );
    },
    [UAPI]: (url) => {
      const user = url.searchParams.get("cpanel.user");
      const account = accounts[user];
      if (!account)
        return whmFail(
          "uapi_cpanel",
          `API failure: (XID x) You do not have a user named “${user}”.`,
        );
      const home = `/home/${user}`;
      switch (fnOf(url)) {
        case "Variables::get_user_information":
          return proxy(uapiOk({ home }));
        case "DomainInfo::domains_data": {
          const [main, ...addons] = account.domains.map((d) => ({
            domain: d.domain,
            documentroot: `${home}/${d.documentroot}`,
            homedir: home,
          }));
          return proxy(
            uapiOk({
              main_domain: main,
              addon_domains: addons,
              sub_domains: [],
              parked_domains: [],
            }),
          );
        }
        case "Fileman::list_files":
          // A directory is a list, or a function returning one; a file is a
          // name, or an object with the fields cPanel lists.
          return proxy(
            uapiOk(
              [
                ...(typeof account.files[url.searchParams.get("dir")] ===
                "function"
                  ? account.files[url.searchParams.get("dir")]()
                  : (account.files[url.searchParams.get("dir")] ?? [])),
              ].map((file) =>
                typeof file === "string"
                  ? { file, type: "file" }
                  : { type: "file", ...file },
              ),
            ),
          );
        case "Fileman::get_file_content":
          return proxy(uapiOk({ content: "<?php $wp_version = '6.9.1';" }));
        case "Stats::get_site_errors":
          return proxy(
            uapiOk((account.errors ?? []).map((entry) => ({ date: 1, entry }))),
          );
        default:
          return proxy({
            status: 0,
            errors: [`unexpected ${fnOf(url)}`],
            data: null,
          });
      }
    },
  };
}

const wpAccount = (domain) => ({
  domains: [{ domain, documentroot: "public_html" }],
  files: { public_html: ["wp-config.php"] },
});

test("WHM lists WordPress across accounts sorted by user, then in cPanel order", async () => {
  const { client, calls } = whmFixture(
    server({
      wptest: {
        domains: [
          { domain: "wp.example.test", documentroot: "public_html" },
          { domain: "shop.example.test", documentroot: "shop" },
          { domain: "plain.example.test", documentroot: "plain" },
        ],
        files: {
          public_html: ["wp-config.php", "index.php"],
          shop: ["wp-config.php"],
          plain: ["index.html"],
        },
      },
      other: wpAccount("blog.other.test"),
    }),
  );
  const sites = await client.listSites({ includeEnvironments: true });
  assert.deepEqual(
    sites.map((site) => site.id),
    [
      "other:blog.other.test",
      "wptest:wp.example.test",
      "wptest:shop.example.test",
    ],
  );
  assert.deepEqual(sites[1], {
    id: "wptest:wp.example.test",
    name: "wp.example.test",
    displayName: "wp.example.test (wptest)",
    status: "unknown",
    primaryDomain: "wp.example.test",
    environments: [
      {
        id: "wptest:wp.example.test",
        name: "live",
        displayName: "Live",
        isBlocked: false,
        isPremium: false,
        wordpressVersion: "6.9.1",
        primaryDomain: "https://wp.example.test/",
      },
    ],
  });
  const accounts = calls.find(
    (call) => call.url.pathname === "/json-api/listaccts",
  );
  assert.equal(accounts.url.searchParams.get("want"), "user,domain,suspended");
  // One toolkit per operation: the server list is asked for once, and each
  // account's feature once.
  assert.equal(installationRequests(calls).length, 1);
  assert.equal(
    calls.filter(
      (call) => call.url.pathname === "/json-api/verify_user_has_feature",
    ).length,
    2,
  );
  assert.equal(
    (await client.listSites()).every((site) => !("environments" in site)),
    true,
  );
});

test("WHM discovers at most four accounts at once, keeps the listing order, and asks for the server list once", async () => {
  const users = ["ffff", "eeee", "dddd", "cccc", "bbbb", "aaaa"];
  const base = server(
    Object.fromEntries(users.map((user) => [user, wpAccount(`${user}.test`)])),
  );
  let inFlight = 0;
  let most = 0;
  const { client, calls } = whmFixture({
    ...base,
    [UAPI]: async (url, init) => {
      if (fnOf(url) !== "DomainInfo::domains_data")
        return base[UAPI](url, init);
      inFlight += 1;
      most = Math.max(most, inFlight);
      // Hold each account's discovery open long enough for the others to start.
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return base[UAPI](url, init);
    },
  });
  const sites = await client.listSites();
  assert.deepEqual(
    sites.map((site) => site.id),
    [...users].sort().map((user) => `${user}:${user}.test`),
  );
  assert.equal(most, 4);
  assert.equal(installationRequests(calls).length, 1);
});

test("WHM leaves suspended accounts out and refuses their ids", async () => {
  const { client, calls } = whmFixture(
    server({
      wptest: wpAccount("wp.example.test"),
      susp: { ...wpAccount("x.test"), suspended: 1 },
    }),
  );
  assert.deepEqual(
    (await client.listSites()).map((site) => site.id),
    ["wptest:wp.example.test"],
  );
  const message =
    "The cPanel account susp is suspended, no longer exists on this server, or is not managed by this WHM user.";
  await assert.rejects(client.getSite("susp:x.test"), {
    code: "not_found",
    message,
  });
  await assert.rejects(client.listEnvironments("susp:x.test"), {
    code: "not_found",
    message,
  });
  await assert.rejects(client.getSite("ghost:x.test"), {
    code: "not_found",
    message:
      "The cPanel account ghost is suspended, no longer exists on this server, or is not managed by this WHM user.",
  });
  assert.deepEqual(
    proxied(calls).filter((call) =>
      ["susp", "ghost"].includes(call.url.searchParams.get("cpanel.user")),
    ),
    [],
  );
});

test("WHM keeps only listed, active accounts with a valid user name", async () => {
  const entry = (user, suspended) => ({ user, domain: "x.test", suspended });
  const { client } = whmFixture({
    ...server({
      zed: wpAccount("zed.test"),
      alpha: wpAccount("alpha.test"),
      sleepy: wpAccount("sleepy.test"),
      awake: wpAccount("awake.test"),
      "Bad User": wpAccount("bad.test"),
    }),
    [LISTACCTS]: () =>
      whmOk("listaccts", {
        acct: [
          entry("zed", 0),
          entry("alpha", "0"),
          entry("awake", false),
          entry("sleepy", 1),
          entry("sleepy2", "1"),
          entry("Bad User", 0),
          entry("nosuspend", undefined),
          null,
          { domain: "x.test", suspended: 0 },
        ],
      }),
  });
  assert.deepEqual(
    (await client.listSites()).map((site) => site.id),
    ["alpha:alpha.test", "awake:awake.test", "zed:zed.test"],
  );
});

test("WHM refuses an account list it cannot read", async () => {
  for (const data of [null, {}, { acct: "x" }, { acct: {} }]) {
    const { client } = whmFixture({
      [LISTACCTS]: () => whmOk("listaccts", data),
    });
    await assert.rejects(client.listSites(), {
      code: "provider_error",
      message: "WHM returned an invalid account list.",
    });
  }
});

test("WHM treats WP Toolkit per account on a mixed server", async () => {
  const { client, calls } = whmFixture(
    server(
      {
        withwpt: {
          domains: [{ domain: "withwpt.test", documentroot: "public_html" }],
          files: {},
        },
        nowpt: { ...wpAccount("nowpt.test"), wpt: false },
      },
      {
        toolkit: [
          {
            ...installation(7, "/home/withwpt/public_html"),
            url: "https://withwpt.test",
          },
        ],
      },
    ),
  );
  const sites = await client.listSites({ includeEnvironments: true });
  assert.deepEqual(
    sites.map((site) => site.id),
    ["nowpt:nowpt.test", "withwpt:withwpt.test"],
  );
  // The toolkit entry carries WP Toolkit's data, the other one a Fileman read.
  assert.equal(sites[0].environments[0].primaryDomain, "https://nowpt.test/");
  assert.equal(sites[0].environments[0].wordpressVersion, "6.9.1");
  assert.equal(sites[1].environments[0].primaryDomain, "https://withwpt.test/");
  assert.equal(sites[1].environments[0].wordpressVersion, "6.9");
  assert.equal(installationRequests(calls).length, 1);
  const filesOf = (user) =>
    proxied(calls, "Fileman::list_files").filter(
      (call) => call.url.searchParams.get("cpanel.user") === user,
    );
  assert.equal(filesOf("nowpt").length, 1);
  assert.equal(filesOf("withwpt").length, 0);
  // No WP Toolkit for `nowpt` means neither its home nor the list is read for it.
  assert.deepEqual(
    proxied(calls, "Variables::get_user_information").map((call) =>
      call.url.searchParams.get("cpanel.user"),
    ),
    ["withwpt"],
  );
});

test("WHM splits one WP Toolkit list between accounts whose names share a prefix", async () => {
  const { client, calls } = whmFixture(
    server(
      {
        ab: {
          domains: [{ domain: "a.test", documentroot: "public_html" }],
          files: {},
        },
        abc: {
          domains: [{ domain: "b.test", documentroot: "public_html" }],
          files: {},
        },
      },
      {
        // Installation 2 names a domain of `ab` but lives in `abc`'s home, so
        // a home filter that lets `abc` through for `ab` would give `a.test`
        // installation 2's data.
        toolkit: [
          { ...installation(1, "/home/ab/public_html"), version: "6.1" },
          {
            ...installation(2, "/home/abc/public_html"),
            url: "https://a.test",
            version: "6.2",
          },
        ],
      },
    ),
  );
  const sites = await client.listSites({ includeEnvironments: true });
  assert.deepEqual(
    sites.map((site) => [site.id, site.environments.length]),
    [
      ["ab:a.test", 1],
      ["abc:b.test", 1],
    ],
  );
  assert.deepEqual(
    sites.map((site) => [
      site.environments[0].primaryDomain,
      site.environments[0].wordpressVersion,
    ]),
    [
      ["https://site1.test/", "6.1"],
      ["https://a.test/", "6.2"],
    ],
  );
  assert.equal(installationRequests(calls).length, 1);
  assert.equal(proxied(calls, "Variables::get_user_information").length, 2);
  assert.equal(proxied(calls, "Fileman::list_files").length, 0);
});

test("WHM fails the listing when the server-wide WP Toolkit list fails, and asks for it once", async () => {
  for (const [status, body] of [
    [500, "Internal Server Error"],
    [502, "Bad Gateway"],
    [503, "Service Unavailable"],
  ]) {
    const { client, calls } = whmFixture({
      ...server(
        Object.fromEntries(
          ["aaa", "bbb", "ccc", "ddd", "eee", "fff"].map((user) => [
            user,
            wpAccount(`${user}.test`),
          ]),
        ),
      ),
      [`GET ${INSTALLATIONS}`]: () => [status, body, "text/html"],
    });
    await assert.rejects(client.listSites(), { code: "provider_error" });
    // Not an empty inventory, no request again for another account, and no
    // Fileman fallback for an account whose WP Toolkit could not be read.
    assert.equal(installationRequests(calls).length, 1);
    assert.equal(proxied(calls, "Fileman::list_files").length, 0);
    // The four accounts in flight all waited for the one list; no account
    // after them is started once it has failed.
    for (const user of ["eee", "fff"])
      assert.equal(
        calls.some(
          (call) =>
            call.url.searchParams.get("cpanel.user") === user ||
            call.url.searchParams.get("user") === user,
        ),
        false,
        user,
      );
  }
});

test("WHM skips an account that fails with a provider error and lists the others", async () => {
  const base = server({
    broken: wpAccount("broken.test"),
    gone: wpAccount("gone.test"),
    good: wpAccount("good.test"),
  });
  const { client } = whmFixture({
    ...base,
    [UAPI]: (url, init) => {
      const user = url.searchParams.get("cpanel.user");
      if (fnOf(url) === "DomainInfo::domains_data") {
        if (user === "broken")
          return proxy({
            status: 0,
            errors: ["The account is damaged."],
            data: null,
          });
        if (user === "gone")
          return whmFail(
            "uapi_cpanel",
            "API failure: (XID x) You do not have a user named “gone”.",
          );
      }
      return base[UAPI](url, init);
    },
  });
  assert.deepEqual(
    (await client.listSites()).map((site) => site.id),
    ["good:good.test"],
  );
});

test("WHM ends the listing on a rejected token, at listaccts or at an account", async () => {
  const denied = whmFixture({
    [LISTACCTS]: () => [403, "Forbidden", "text/html"],
  });
  await assert.rejects(denied.client.listSites(), {
    code: "credential_invalid",
  });
  // Four accounts are discovered at once: `aaa` fails while the next three
  // are still in flight, and no account after them is started.
  const base = server({
    aaa: wpAccount("aaa.test"),
    bbb: wpAccount("bbb.test"),
    ccc: wpAccount("ccc.test"),
    ddd: wpAccount("ddd.test"),
    yyy: wpAccount("yyy.test"),
    zzz: wpAccount("zzz.test"),
  });
  const { client, calls } = whmFixture({
    ...base,
    [UAPI]: async (url, init) => {
      if (url.searchParams.get("cpanel.user") === "aaa")
        return [403, "Forbidden", "text/html"];
      await new Promise((resolve) => setTimeout(resolve, 25));
      return base[UAPI](url, init);
    },
  });
  await assert.rejects(client.listSites(), { code: "credential_invalid" });
  for (const user of ["yyy", "zzz"])
    assert.equal(
      calls.some(
        (call) =>
          call.url.searchParams.get("cpanel.user") === user ||
          call.url.searchParams.get("user") === user,
      ),
      false,
      user,
    );
});

test("WHM reads one site by id from that account only", async () => {
  const { client, calls } = whmFixture(
    server({
      wptest: wpAccount("wp.example.test"),
      other: wpAccount("blog.other.test"),
    }),
  );
  const site = await client.getSite("wptest:wp.example.test");
  assert.equal(site.id, "wptest:wp.example.test");
  assert.equal(site.displayName, "wp.example.test (wptest)");
  assert.deepEqual(
    site.environments.map((env) => env.id),
    ["wptest:wp.example.test"],
  );
  assert.deepEqual(
    (await client.listEnvironments("wptest:wp.example.test")).map((env) => [
      env.id,
      env.name,
    ]),
    [["wptest:wp.example.test", "live"]],
  );
  assert.deepEqual(
    [
      ...new Set(
        proxied(calls).map((call) => call.url.searchParams.get("cpanel.user")),
      ),
    ],
    ["wptest"],
  );
  for (const id of ["wptest:nope.test", "wptest:blog.other.test"]) {
    await assert.rejects(client.getSite(id), {
      code: "not_found",
      message: "No WordPress was found at the root of this domain.",
    });
  }
});

test("WHM id helpers build and parse account:domain ids", () => {
  assert.equal(
    whmSiteId("wptest", "wp.example.test"),
    "wptest:wp.example.test",
  );
  assert.deepEqual(parseWhmId("wptest:wp.example.test"), {
    user: "wptest",
    domain: "wp.example.test",
  });
  assert.equal(parseWhmId("wptest:WP.Example.test").domain, "wp.example.test");
  for (const id of [
    "wp.example.test",
    "Root:x.test",
    "wptest:",
    ":x.test",
    "",
    "wptest:bad domain",
    "wptest:a:b.test",
    "domain:x.test:y",
  ])
    assert.throws(() => parseWhmId(id), { code: "usage_error" }, id);
});

test("WHM refuses a bad id or a missing address before any request", async () => {
  const { client, calls } = whmFixture(server({}));
  await assert.rejects(client.getSite("wp.example.test"), {
    code: "usage_error",
  });
  await assert.rejects(client.listEnvironments("Root:x.test"), {
    code: "usage_error",
  });
  assert.deepEqual(calls, []);
  const unconfigured = whmFixture(server({}), { missingUrl: true });
  await assert.rejects(unconfigured.client.listSites(), {
    code: "config_error",
  });
  await assert.rejects(unconfigured.client.getSite("wptest:x.test"), {
    code: "config_error",
  });
  await assert.rejects(unconfigured.client.listEnvironments("wptest:x.test"), {
    code: "config_error",
  });
  assert.deepEqual(unconfigured.calls, []);
});

/* -------------------------------------------------------------------------- */
/* Backups, error logs and the capability table                               */
/* -------------------------------------------------------------------------- */

const ENV = "wptest:wp.example.test";
const BACKUP_FILE = "backup-10.9.2026_13-52-15_wptest.tar.gz";
const BACKUP_NOTE =
  "cPanel is creating the account backup in the background. It can take several minutes; check hosting_backups_list for the new file.";

/** The account's backup listings: the ones of its home directory (dir ""). */
const homeListings = (calls) =>
  proxied(calls, "Fileman::list_files").filter(
    (call) => call.url.searchParams.get("dir") === "",
  );
const backupStarts = (calls) =>
  calls.filter(
    (call) =>
      call.method === "POST" && call.url.pathname === "/json-api/uapi_cpanel",
  );
const formOf = (call) => new URLSearchParams(String(call.body));

function backupServer(homeFiles = []) {
  return server({
    wptest: {
      ...wpAccount("wp.example.test"),
      files: { public_html: ["wp-config.php"], "": homeFiles },
      errors: ["[core:crit] AH00529 example", "[core:error] second"],
    },
    other: {
      ...wpAccount("blog.other.test"),
      files: {
        public_html: ["wp-config.php"],
        "": [{ file: "backup-10.9.2026_13-52-15_other.tar.gz", size: "9" }],
      },
    },
  });
}

test("WHM lists only the selected account's home-directory backups through uapi_cpanel", async () => {
  const { client, calls } = whmFixture(
    backupServer([
      { file: BACKUP_FILE, size: "37055357", mtime: 1791553935 },
      { file: "backup-10.9.2026_13-52-15_other.tar.gz", size: "1" },
      { file: "notes.txt", size: "3" },
    ]),
  );
  assert.deepEqual(await client.read({ kind: "backups", envId: ENV }), {
    backups: [
      {
        id: BACKUP_FILE,
        filename: BACKUP_FILE,
        size_bytes: 37055357,
        created_at: "2026-10-09T13:52:15Z",
      },
    ],
  });
  const [listing, ...more] = homeListings(calls);
  assert.deepEqual(more, []);
  assert.equal(listing.url.searchParams.get("cpanel.user"), "wptest");
  assert.equal(listing.url.searchParams.get("types"), "file");
  assert.equal(listing.authorization, `whm root:${TOKEN}`);
  // The other account is never touched, and nothing goes to a cPanel port.
  assert.ok(
    proxied(calls).every(
      (call) => call.url.searchParams.get("cpanel.user") === "wptest",
    ),
  );
  assert.ok(calls.every((call) => call.url.origin === BASE));
});

test("WHM lists backups newest first and skips names and sizes it cannot use", async () => {
  const { client } = whmFixture(
    backupServer([
      { file: "backup-9.30.2026_01-02-03_wptest.tar.gz", size: "5" },
      { file: "backup-10.9.2026_13-52-15_wptest.tar.gz", size: "7" },
      { file: "backup-10.9.2026_13-52-16_wptest.tar.gz", size: "n/a" },
      { file: "backup-10.9.2026_13-52-17_wptest.tar.gz.part", size: "9" },
    ]),
  );
  const { backups } = await client.read({ kind: "backups", envId: ENV });
  assert.deepEqual(
    backups.map((backup) => [backup.created_at, backup.size_bytes]),
    [
      ["2026-10-09T13:52:15Z", 7],
      ["2026-09-30T01:02:03Z", 5],
    ],
  );
});

test("WHM backups and logs refuse an id that is not a WordPress site of an existing account", async () => {
  const malformed = whmFixture(backupServer());
  for (const request of [
    { kind: "backups", envId: "wp.example.test" },
    { kind: "logs", envId: "Root:x.test", fileName: "error", lines: 5 },
  ])
    await assert.rejects(malformed.client.read(request), {
      code: "usage_error",
    });
  await assert.rejects(
    malformed.client.action({
      kind: "create-backup",
      envId: "wp.example.test",
    }),
    { code: "usage_error" },
  );
  assert.deepEqual(malformed.calls, []);
  const { client, calls } = whmFixture(backupServer());
  for (const envId of [
    "wptest:plain.example.test",
    // A real site, but of another account.
    "wptest:blog.other.test",
  ]) {
    for (const request of [
      { kind: "backups", envId },
      { kind: "logs", envId, fileName: "error", lines: 5 },
    ])
      await assert.rejects(client.read(request), {
        code: "not_found",
        message: "No WordPress was found at the root of this domain.",
      });
    await assert.rejects(client.action({ kind: "create-backup", envId }), {
      code: "not_found",
    });
  }
  assert.deepEqual(backupStarts(calls), []);
  assert.deepEqual(proxied(calls, "Stats::get_site_errors"), []);
  assert.deepEqual(homeListings(calls), []);
});

test("WHM backup creation with wait: false starts the backup once and returns at once", async () => {
  const sleeps = [];
  const { client, calls } = whmFixture(backupServer(), {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const result = await client.action({
    kind: "create-backup",
    envId: ENV,
    wait: false,
  });
  assert.deepEqual(result, {
    provider: "whm",
    action: "backups.create",
    status: 202,
    message: BACKUP_NOTE,
    raw: { started: true, note: BACKUP_NOTE },
  });
  const [start, ...more] = backupStarts(calls);
  assert.deepEqual(more, []);
  const form = formOf(start);
  assert.equal(form.get("cpanel.user"), "wptest");
  assert.equal(form.get("cpanel.module"), "Backup");
  assert.equal(form.get("cpanel.function"), "fullbackup_to_homedir");
  assert.equal(start.url.search, "");
  assert.equal(start.authorization, `whm root:${TOKEN}`);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(homeListings(calls), []);
});

test("WHM backup creation waits for a new, stable file, polling on the client's sleep", async () => {
  let listing = 0;
  const sleeps = [];
  const { client, calls } = whmFixture(
    backupServer(() => {
      listing++;
      return listing === 1
        ? []
        : [{ file: BACKUP_FILE, size: listing === 2 ? "10" : "20", mtime: 1 }];
    }),
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  const result = await client.action({ kind: "create-backup", envId: ENV });
  assert.equal(result.provider, "whm");
  assert.equal(result.action, "backups.create");
  assert.equal(result.raw.backup_id, BACKUP_FILE);
  assert.deepEqual(sleeps, [10_000, 10_000, 10_000]);
  // The account is listed before the start, so only a new file counts.
  const requested = calls
    .filter(
      (call) =>
        call.url.pathname === "/json-api/uapi_cpanel" &&
        (call.method === "POST" ||
          (fnOf(call.url) === "Fileman::list_files" &&
            call.url.searchParams.get("dir") === "")),
    )
    .map((call) => call.method);
  assert.deepEqual(requested, ["GET", "POST", "GET", "GET", "GET"]);
  const status = await client.operationStatus(result.operationId);
  assert.equal(status.provider, "whm");
  assert.equal(status.done, true);
  assert.equal(status.failed, false);
  assert.equal(status.status, 200);
  await assert.rejects(client.operationStatus("unknown"), {
    code: "provider_unsupported",
  });
});

test("a WHM backup that cPanel refuses to start fails without waiting and is never repeated", async () => {
  const sleeps = [];
  const refused = whmFixture(
    {
      ...backupServer(),
      [POST_UAPI]: () =>
        proxy({
          status: 0,
          errors: ["The disk quota is exceeded."],
          data: null,
        }),
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  await assert.rejects(
    refused.client.action({ kind: "create-backup", envId: ENV }),
    { code: "provider_error", message: /disk quota is exceeded/ },
  );
  assert.deepEqual(sleeps, []);
  // A 503 on the start is not replayed, whatever the client retries.
  const unavailable = () => [503, "Service Unavailable", "text/plain"];
  const { client, calls } = whmFixture(
    {
      ...backupServer(),
      [POST_UAPI]: unavailable,
    },
    { retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 } },
  );
  await assert.rejects(client.action({ kind: "create-backup", envId: ENV }));
  assert.equal(backupStarts(calls).length, 1);
});

test("an account removed after the listing fails a backup with the account message", async () => {
  // The account is still in listaccts and answers its domains; only the
  // backup start finds it gone.
  for (const wait of [false, true]) {
    const { client, calls } = whmFixture({
      ...backupServer(),
      [POST_UAPI]: () =>
        whmFail(
          "uapi_cpanel",
          "API failure: (XID abc) You do not have a user named “wptest”.",
        ),
    });
    await assert.rejects(
      client.action({ kind: "create-backup", envId: ENV, wait }),
      {
        code: "not_found",
        message:
          "The cPanel account wptest is suspended, no longer exists on this server, or is not managed by this WHM user.",
      },
    );
    assert.equal(backupStarts(calls).length, 1);
  }
  // Gone before the action even resolves the site: no account request at all.
  const gone = whmFixture(server({ other: wpAccount("blog.other.test") }));
  for (const run of [
    () => gone.client.action({ kind: "create-backup", envId: ENV }),
    () => gone.client.read({ kind: "backups", envId: ENV }),
    () =>
      gone.client.read({
        kind: "logs",
        envId: ENV,
        fileName: "error",
        lines: 5,
      }),
  ])
    await assert.rejects(run(), {
      code: "not_found",
      message:
        "The cPanel account wptest is suspended, no longer exists on this server, or is not managed by this WHM user.",
    });
  assert.deepEqual(proxied(gone.calls), []);
});

test("an already aborted WHM backup makes no request, and aborting the poll stops it", async () => {
  const aborted = whmFixture(backupServer());
  await assert.rejects(
    aborted.client.action({
      kind: "create-backup",
      envId: ENV,
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(aborted.calls, []);
  const controller = new AbortController();
  const { client, calls } = whmFixture(backupServer(), {
    // Like a sleep that ignores its signal: the poll must still stop.
    sleep: async () => controller.abort(),
  });
  await assert.rejects(
    client.action({
      kind: "create-backup",
      envId: ENV,
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(homeListings(calls).length, 1);
  assert.equal(backupStarts(calls).length, 1);
});

test("WHM reads the domain error log through Stats::get_site_errors", async () => {
  const { client, calls } = whmFixture(backupServer());
  assert.deepEqual(
    await client.read({
      kind: "logs",
      envId: ENV,
      fileName: "error",
      lines: 50,
    }),
    { lines: ["[core:crit] AH00529 example", "[core:error] second"] },
  );
  const [call, ...more] = proxied(calls, "Stats::get_site_errors");
  assert.deepEqual(more, []);
  assert.equal(call.url.searchParams.get("cpanel.user"), "wptest");
  assert.equal(call.url.searchParams.get("domain"), "wp.example.test");
  assert.equal(call.url.searchParams.get("log"), "error");
  assert.equal(call.url.searchParams.get("maxlines"), "50");
  assert.equal(call.authorization, `whm root:${TOKEN}`);
  // Only the error log exists here, and asking for another sends nothing.
  const before = calls.length;
  await assert.rejects(
    client.read({ kind: "logs", envId: ENV, fileName: "access", lines: 5 }),
    { code: "provider_unsupported" },
  );
  assert.equal(calls.length, before);
});

test("WHM keeps the cPanel capability table and rejects what it does not serve", async () => {
  const { client, calls } = whmFixture(backupServer());
  const capabilities = await client.read({ kind: "capabilities" });
  assert.deepEqual(capabilities, WHM_CAPABILITIES);
  const byName = new Map(capabilities.map((entry) => [entry.name, entry]));
  for (const name of [
    "backups.list",
    "backups.create",
    "logs.get",
    "novamira.setup",
  ])
    assert.equal(byName.get(name).supported, true, name);
  assert.equal(byName.get("backups.restore").supported, false);
  assert.match(byName.get("backups.create").notes, /disk quota/);
  assert.deepEqual(calls, []);
  for (const request of [{ kind: "plugins", envId: ENV }, { kind: "activity" }])
    await assert.rejects(client.read(request), {
      code: "provider_unsupported",
    });
  await assert.rejects(
    client.action({ kind: "clear-cache", cache: "object" }),
    {
      code: "provider_unsupported",
    },
  );
  assert.deepEqual(calls, []);
});

test("the dashboard backup page names the WHM account backup and its disk-quota cost", () => {
  const target = {
    profile: "server",
    site: "wp.example.test",
    env: ENV,
  };
  const review = {
    ...target,
    id: "review",
    operation: "create",
    provider: "whm",
    targetUrl: "https://wp.example.test/",
    backupId: "Novamira HQ",
    expiresAt: 1000,
  };
  const page = renderHtml(renderBackupCreate({ create: true, target, review }));
  assert.match(page, />Create cPanel account backup<\/button>/);
  assert.match(
    page,
    /The backup contains the whole cPanel account and counts against its disk quota\./,
  );
  assert.doesNotMatch(page, /files and database/);
  assert.doesNotMatch(page, /Backup label/);
  const done = renderHtml(
    renderBackupCreate({
      create: true,
      target,
      job: { review, status: "completed" },
    }),
  );
  assert.match(done, /href="\/hosting-tools\?[^"]*"[^>]*>View backups</);
  assert.doesNotMatch(done, /backup-restore/);
});
