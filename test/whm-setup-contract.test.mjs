// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { createWhmApi } from "../dist/hosting/providers/whm-api.js";
import { sessionUploads } from "../dist/hosting/providers/whm-session.js";
import { provisionNovamira } from "../dist/provisioning/setup.js";
import {
  BASE,
  CPANEL,
  TOKEN,
  whmFail,
  whmFixture,
  whmOk,
} from "./helpers/whm-fixture.mjs";

const WPT = `${BASE}/cgi/wpt/index.php`;
const WPT_PATH = "/cgi/wpt/index.php";
const INSTALLATION_ID = 7;
const WP_CLI = `POST ${WPT}/v1/installations/7/features/wp-cli`;
const UPLOAD = `POST ${WPT}/v1/installations/7/features/uploader/plugins`;
const TASK = `GET ${WPT}/v1/background-tasks/install-custom-plugin/3`;
const ACTIVATE = `PUT ${WPT}/v1/installations/7/plugins/novamira/status`;
const INSTALLATIONS = `GET ${WPT}/v1/installations`;
const CACHE_CLEANER = `POST ${WPT}/v1/cache-cleaner`;
const REFRESH_TASK = `GET ${WPT}/v1/background-tasks/clear-installation-cache/11`;
const LISTACCTS = `GET ${BASE}/json-api/listaccts`;
const FEATURE = `GET ${BASE}/json-api/verify_user_has_feature`;
const UAPI = `GET ${BASE}/json-api/uapi_cpanel`;
const ENV = "wptest:wp.example.test";

const INSTALL = {
  id: INSTALLATION_ID,
  url: "https://wp.example.test",
  version: "7.1.3",
  path: "/home/wptest/public_html",
  status: { alive: true, multisite: false },
};
const NOVAMIRA = { name: "novamira", status: "active", version: "1.12.8" };
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(0)]);

const cliOk = (stdout) => [200, { exitCode: 0, stdout, stderr: "" }];
const zipFetch = async () =>
  new Response(ZIP, { headers: { "content-type": "application/zip" } });
const proxy = (data) =>
  whmOk("uapi_cpanel", {
    uapi: { status: 1, errors: null, messages: null, warnings: null, data },
  });
const fnOf = (url) =>
  `${url.searchParams.get("cpanel.module")}::${url.searchParams.get("cpanel.function")}`;

/**
 * The WHM side of one account, `wptest`, whose main domain `wp.example.test`
 * has its WordPress in `public_html`. `wpt: false` takes WP Toolkit away from
 * the account (its feature list), which sends setup down the installer path.
 */
function account({ wpt = true, users = ["wptest"] } = {}) {
  return {
    [LISTACCTS]: () =>
      whmOk("listaccts", {
        acct: users.map((user) => ({
          user,
          domain: "wp.example.test",
          suspended: 0,
        })),
      }),
    [FEATURE]: () =>
      whmOk("verify_user_has_feature", {
        has_feature: wpt ? 1 : 0,
        query_feature: "wp-toolkit",
      }),
    [UAPI]: (url) => {
      switch (fnOf(url)) {
        case "Variables::get_user_information":
          return proxy({ home: "/home/wptest" });
        case "DomainInfo::domains_data":
          return proxy({
            main_domain: {
              domain: "wp.example.test",
              documentroot: "/home/wptest/public_html",
              homedir: "/home/wptest",
            },
            addon_domains: [],
            sub_domains: [],
            parked_domains: [],
          });
        case "Fileman::list_files":
          return proxy(
            url.searchParams.get("dir") === "public_html"
              ? [{ file: "wp-config.php", type: "file" }]
              : [],
          );
        case "Fileman::get_file_content":
          return proxy({
            content:
              url.searchParams.get("file") === ".htaccess"
                ? "# BEGIN WordPress\nRewriteRule . /index.php [L]\n# END WordPress\n"
                : "<?php $wp_version = '7.1.3';",
          });
        default:
          return proxy(null);
      }
    },
  };
}

/** WP Toolkit fake at the WHM level: plugin state, options and the WP-CLI argv. */
function toolkit(initial = null, accountOptions = {}) {
  const state = {
    plugin: initial,
    options: new Map(),
    argv: [],
    uploads: 0,
    activations: 0,
    form: undefined,
    php: "8.2.34",
    /** WP Toolkit calls in the order they arrived. */
    log: [],
    refreshes: [],
  };
  const routes = {
    ...account(accountOptions),
    [INSTALLATIONS]: () => [200, [INSTALL]],
    [WP_CLI]: async (url, init) => {
      const { command } = JSON.parse(String(init.body));
      state.argv.push(command);
      const [a, b, c, d] = command;
      if (a === "eval") return cliOk(state.php);
      if (a === "plugin" && b === "list") {
        state.log.push("plugin list");
        return cliOk(JSON.stringify(state.plugin ? [state.plugin] : []));
      }
      if (a === "option" && b === "update") {
        state.options.set(c, d);
        return cliOk("Success");
      }
      if (a === "option" && b === "get")
        return state.options.has(c)
          ? cliOk(state.options.get(c))
          : [200, { exitCode: 1, stdout: "", stderr: "Error" }];
      throw new Error(`unexpected wp-cli ${command.join(" ")}`);
    },
    [CACHE_CLEANER]: async (url, init) => {
      state.log.push("refresh");
      state.refreshes.push(JSON.parse(String(init.body)));
      return [
        200,
        {
          url: `${WPT_PATH}/v1/background-tasks/clear-installation-cache/11`,
          task: {
            id: 11,
            code: "clear-installation-cache",
            status: "not_started",
            errors: [],
          },
        },
      ];
    },
    [REFRESH_TASK]: () => [
      200,
      {
        id: 11,
        code: "clear-installation-cache",
        status: "done",
        progress: 100,
        errors: [],
      },
    ],
    [UPLOAD]: async (url, init) => {
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("status"), "true");
      state.form = init.body;
      state.log.push("upload");
      state.uploads++;
      state.plugin = { name: "novamira", status: "active", version: "1.12.8" };
      return [
        200,
        {
          url: `${WPT_PATH}/v1/background-tasks/install-custom-plugin/3`,
          task: {
            id: 3,
            code: "install-custom-plugin",
            status: "not_started",
            errors: [],
          },
        },
      ];
    },
    [TASK]: () => [
      200,
      {
        id: 3,
        code: "install-custom-plugin",
        status: "done",
        progress: 100,
        errors: [],
        publicParams: { pluginName: "novamira", pluginVersion: "1.12.8" },
      },
    ],
    [ACTIVATE]: async (url, init) => {
      assert.deepEqual(JSON.parse(String(init.body)), { status: true });
      state.log.push("activate");
      state.activations++;
      state.plugin = { ...state.plugin, status: "active" };
      return [200, {}];
    },
  };
  return { state, routes };
}

const setup = (client, extra = {}) =>
  client.action({ kind: "setup-novamira", envId: ENV, ...extra });

const wptCalls = (calls) =>
  calls.filter((call) => call.url.pathname.startsWith(WPT_PATH));

test("WHM setup with WP Toolkit uploads the official ZIP, activates and enables AI Abilities through the WHM endpoint", async () => {
  const { state, routes } = toolkit();
  const { client, calls } = whmFixture(routes, { transferFetch: zipFetch });
  const result = await setup(client);
  assert.equal(result.provider, "whm");
  assert.equal(result.action, "novamira.setup");
  assert.equal(result.status, 200);
  assert.deepEqual(result.raw, {
    siteUrl: "https://wp.example.test/",
    version: "1.12.8",
    aiEnabled: true,
    warnings: [],
  });
  assert.equal(state.uploads, 1);
  assert.equal(
    state.options.get("novamira_ai_abilities_domain"),
    "wp.example.test",
  );
  assert.equal(state.options.get("novamira_ai_abilities_enabled"), "1");
  // The multipart field names WP Toolkit expects, and the exact ZIP.
  const file = state.form.get("file");
  assert.equal(file.name, "novamira.zip");
  assert.equal(file.type, "application/zip");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), ZIP);
  assert.deepEqual([...state.form.keys()].sort(), ["file", "status"]);
  // Every WP Toolkit request carries the WHM header; nothing goes to cPanel.
  const toolkitCalls = wptCalls(calls);
  assert.ok(toolkitCalls.length >= 8);
  assert.ok(
    toolkitCalls.every((call) => call.authorization === `whm root:${TOKEN}`),
  );
  assert.ok(calls.every((call) => call.url.origin === BASE));
  assert.ok(calls.every((call) => call.url.port !== "2083"));
  assert.ok(calls.every((call) => call.cookie === null));
  assert.ok(calls.every((call) => !call.url.href.includes(TOKEN)));
  // The installation is the global WHM id, not a per-account one.
  assert.ok(
    toolkitCalls.some(
      (call) =>
        call.url.pathname ===
        `${WPT_PATH}/v1/installations/${String(INSTALLATION_ID)}/features/wp-cli`,
    ),
  );
  // WP-CLI receives an argv array, never a shell string.
  assert.deepEqual(state.argv[0], ["eval", "echo PHP_VERSION;"]);
  assert.deepEqual(
    state.argv.find((argv) => argv[1] === "update"),
    ["option", "update", "novamira_ai_abilities_domain", "wp.example.test"],
  );
});

test("WHM setup with WP Toolkit refreshes WP Toolkit's cache first and polls the task on the client's sleep", async () => {
  const { state, routes } = toolkit();
  let polls = 0;
  const original = routes[REFRESH_TASK];
  routes[REFRESH_TASK] = () => {
    polls++;
    return polls < 3
      ? [200, { id: 11, code: "clear-installation-cache", status: "running" }]
      : original();
  };
  const pauses = [];
  const { client } = whmFixture(routes, {
    transferFetch: zipFetch,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  await setup(client, { enableAiAbilities: false });
  assert.deepEqual(state.refreshes, [{ installationsIds: [INSTALLATION_ID] }]);
  assert.equal(polls, 3);
  assert.deepEqual(pauses, [2000, 2000]);
  assert.equal(state.log[0], "refresh");
  assert.ok(state.log.indexOf("refresh") < state.log.indexOf("plugin list"));
  assert.ok(state.log.indexOf("refresh") < state.log.indexOf("upload"));
});

test("WHM setup polls the paths of its own tasks and never follows a returned URL", async () => {
  for (const returned of [
    "https://attacker.example.test/cgi/wpt/index.php/v1/background-tasks/clear-installation-cache/11",
    "//attacker.example.test/steal",
    `${WPT_PATH}/v1/background-tasks/install-custom-plugin/9`,
    `${WPT_PATH}/v1/background-tasks/clear-installation-cache/11/../../9`,
    undefined,
  ]) {
    const { routes } = toolkit();
    const cleaner = routes[CACHE_CLEANER];
    routes[CACHE_CLEANER] = async (url, init) => {
      const [status, body] = await cleaner(url, init);
      return [status, { ...body, url: returned }];
    };
    const upload = routes[UPLOAD];
    routes[UPLOAD] = async (url, init) => {
      const [status, body] = await upload(url, init);
      return [status, { ...body, url: returned }];
    };
    const { client, calls } = whmFixture(routes, { transferFetch: zipFetch });
    await setup(client);
    // The WHM token goes nowhere but to the WHM origin.
    assert.ok(
      calls.every((call) => call.url.origin === BASE),
      String(returned),
    );
    assert.deepEqual(
      calls
        .filter((call) => call.url.pathname.includes("background-tasks"))
        .map((call) => `${call.method} ${call.url.pathname}`),
      [
        `GET ${WPT_PATH}/v1/background-tasks/clear-installation-cache/11`,
        `GET ${WPT_PATH}/v1/background-tasks/install-custom-plugin/3`,
      ],
      String(returned),
    );
  }
});

test("a failed or never finishing WP Toolkit refresh stops WHM setup before any read or upload", async () => {
  const failed =
    "WP Toolkit could not refresh this site's details. Check WP Toolkit in cPanel before retrying.";
  const { state, routes } = toolkit();
  routes[REFRESH_TASK] = () => [
    200,
    { id: 11, code: "clear-installation-cache", status: "error" },
  ];
  const { client } = whmFixture(routes, { transferFetch: zipFetch });
  await assert.rejects(setup(client), {
    code: "provider_error",
    message: failed,
  });
  assert.deepEqual(state.log, ["refresh"]);
  assert.equal(state.uploads, 0);
  const stuck = toolkit();
  let polls = 0;
  stuck.routes[REFRESH_TASK] = () => {
    polls++;
    return [
      200,
      { id: 11, code: "clear-installation-cache", status: "running" },
    ];
  };
  const pauses = [];
  const slow = whmFixture(stuck.routes, {
    transferFetch: zipFetch,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  await assert.rejects(setup(slow.client), {
    code: "provider_error",
    message: failed,
  });
  assert.equal(polls, 31);
  assert.equal(pauses.length, 30);
  assert.deepEqual(stuck.state.log, ["refresh"]);
});

test("WHM setup keeps an existing active Novamira and activates an inactive one without a new ZIP", async () => {
  const active = toolkit(NOVAMIRA);
  await setup(whmFixture(active.routes, { transferFetch: zipFetch }).client);
  assert.equal(active.state.uploads, 0);
  assert.equal(active.state.activations, 0);
  assert.equal(active.state.options.size, 0);
  const inactive = toolkit({ ...NOVAMIRA, status: "inactive" });
  const result = await setup(
    whmFixture(inactive.routes, { transferFetch: zipFetch }).client,
    { enableAiAbilities: true },
  );
  assert.equal(inactive.state.uploads, 0);
  assert.equal(inactive.state.activations, 1);
  assert.equal(result.raw.aiEnabled, true);
});

test("WHM setup stops on a WP Toolkit install that fails and never repeats the upload", async () => {
  const { state, routes } = toolkit();
  routes[TASK] = () => [
    200,
    { id: 3, code: "install-custom-plugin", status: "error", errors: ["x"] },
  ];
  const { client } = whmFixture(routes, { transferFetch: zipFetch });
  await assert.rejects(setup(client), {
    code: "provider_error",
    message: /WP Toolkit could not install Novamira/,
  });
  assert.equal(state.uploads, 1);
  assert.equal(state.options.size, 0);
});

test("a rejected WHM token during setup is credential_invalid", async () => {
  const { routes } = toolkit();
  routes[WP_CLI] = () => [403, "Access denied", "text/plain"];
  const { client } = whmFixture(routes, { transferFetch: zipFetch });
  await assert.rejects(setup(client), { code: "credential_invalid" });
});

test("WHM setup on an unknown site, an account gone, or a bad id changes nothing", async () => {
  const { state, routes } = toolkit();
  const { client, calls } = whmFixture(routes, { transferFetch: zipFetch });
  await assert.rejects(setup(client, { envId: "wptest:nope.example.test" }), {
    code: "not_found",
    message: "No WordPress was found at the root of this domain.",
  });
  await assert.rejects(setup(client, { envId: "wp.example.test" }), {
    code: "usage_error",
  });
  const gone = whmFixture(
    { ...routes, [LISTACCTS]: () => whmOk("listaccts", { acct: [] }) },
    { transferFetch: zipFetch },
  );
  await assert.rejects(setup(gone.client), {
    code: "not_found",
    message:
      "The cPanel account wptest is suspended, no longer exists on this server, or is not managed by this WHM user.",
  });
  assert.equal(state.uploads, 0);
  assert.equal(state.options.size, 0);
  assert.ok([...calls, ...gone.calls].every((call) => call.method === "GET"));
  assert.deepEqual(state.log, []);
});

test("an account removed after the listing fails setup with the account message", async () => {
  const { state, routes } = toolkit();
  routes[FEATURE] = () =>
    whmFail(
      "verify_user_has_feature",
      "API failure: (XID abc) You do not have a user named “wptest”.",
    );
  const { client } = whmFixture(routes, { transferFetch: zipFetch });
  await assert.rejects(setup(client), {
    code: "not_found",
    message:
      "The cPanel account wptest is suspended, no longer exists on this server, or is not managed by this WHM user.",
  });
  assert.deepEqual(state.log, []);
});

test("a WHM setup cancelled before it starts does not touch WP Toolkit", async () => {
  const { state, routes } = toolkit();
  const { client, calls } = whmFixture(routes, { transferFetch: zipFetch });
  await assert.rejects(setup(client, { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(state.log, []);
});

test("a WHM setup cancelled while the cache refresh runs stops before any read or upload", async () => {
  const { state, routes } = toolkit();
  const controller = new AbortController();
  routes[REFRESH_TASK] = () => [
    200,
    { id: 11, code: "clear-installation-cache", status: "running" },
  ];
  let sleeps = 0;
  const { client } = whmFixture(routes, {
    transferFetch: zipFetch,
    sleep: async (ms, signal) => {
      sleeps++;
      controller.abort();
      signal.throwIfAborted();
    },
  });
  await assert.rejects(setup(client, { signal: controller.signal }));
  assert.equal(sleeps, 1);
  assert.deepEqual(state.log, ["refresh"]);
  assert.equal(state.uploads, 0);
});

test("without WP Toolkit WHM setup refuses until the temporary installer is approved, writing nothing", async () => {
  for (const extra of [{}, { allowTemporaryInstaller: false }]) {
    const { state, routes } = toolkit(null, { wpt: false });
    const { client, calls } = whmFixture(routes, { transferFetch: zipFetch });
    await assert.rejects(setup(client, extra), {
      code: "confirmation_required",
    });
    // The account has no WP Toolkit, so the WHM list is never read either.
    assert.deepEqual(wptCalls(calls), []);
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.deepEqual(state.log, []);
  }
});

/* -------------------------------------------------------------------------- */
/* Without WP Toolkit: the installer's uploads through a temporary session    */
/* -------------------------------------------------------------------------- */

const SESSION_SECRET = "SECRETSESSION";
const COOKIE_VALUE = "COOKIEVALUE";
const SESSION_URL = `https://cpanel.other-host.test:2083/cpsess123/login/?session=${SESSION_SECRET}`;
const LOGIN = `GET ${CPANEL}/cpsess123/login/`;
const SESSION_UPLOAD = `POST ${CPANEL}/cpsess123/execute/Fileman/upload_files`;
const LOGOUT = `GET ${CPANEL}/cpsess123/logout/`;
const SESSION_MESSAGE =
  "WHM returned an unusable cPanel session. Nothing was uploaded.";
const LOGIN_MESSAGE =
  "cPanel did not open the temporary session. Nothing was uploaded.";
const REFUSED_MESSAGE =
  "The temporary cPanel session was refused. Nothing was installed.";
const UNREACHABLE_MESSAGE = `Novamira HQ could not reach cPanel at ${CPANEL} to upload the installer. Port 2083 must be reachable from this computer with a valid certificate. Nothing was uploaded.`;

/** Nothing HQ hands back may carry the session secret, its path or the cookie. */
function assertNoSessionSecrets(value, label = "") {
  const parts = [];
  const seen = new Set();
  const visit = (item) => {
    if (item === null || item === undefined || seen.has(item)) return;
    if (typeof item === "object") seen.add(item);
    if (item instanceof Error) {
      // Not the stack: its frames name the fixture's own route handlers.
      parts.push(String(item), item.message);
      parts.push(JSON.stringify(item.details ?? null));
      visit(item.cause);
      return;
    }
    parts.push(typeof item === "string" ? item : JSON.stringify(item));
  };
  visit(value);
  const text = parts.join("\n");
  for (const secret of [SESSION_SECRET, COOKIE_VALUE, "cpsess"])
    assert.ok(!text.includes(secret), `${label} leaked ${secret}: ${text}`);
}

/**
 * A WHM account without WP Toolkit, its files kept in memory: Fileman reads,
 * renames and deletes go through `uapi_cpanel`, uploads through the session
 * at `${CPANEL}/cpsess123`. The site trigger plays the installer's outcome.
 */
function bareWhm(options = {}) {
  const base = options.base ?? BASE;
  const files = new Map(
    Object.entries({
      "public_html/wp-config.php": "<?php",
      "public_html/wp-includes/version.php": "<?php\n$wp_version = '7.1.3';\n",
      "public_html/.htaccess":
        "# BEGIN WordPress\nRewriteRule . /index.php [L]\n# END WordPress\n",
    }),
  );
  const deleted = [];
  const triggers = [];
  const session = { logins: 0, cookie: undefined, logouts: 0 };
  const list = (dir, type) =>
    [
      ...new Set(
        [...files.keys()]
          .filter((p) => p.startsWith(`${dir}/`))
          .map((p) => p.slice(dir.length + 1).split("/")[0]),
      ),
    ]
      .filter(
        (name) =>
          (type === "dir") ===
          [...files.keys()].some((p) => p.startsWith(`${dir}/${name}/`)),
      )
      .map((file) => ({ file, type, mtime: Math.floor(Date.now() / 1000) }));
  const fail = (message) =>
    whmOk("uapi_cpanel", {
      uapi: { status: 0, errors: [message], messages: null, data: null },
    });
  const fileman = (fn, params) => {
    switch (fn) {
      case "list_files":
        return proxy(list(params.get("dir"), params.get("types") ?? "file"));
      case "get_file_content": {
        const path = `${params.get("dir")}/${params.get("file")}`;
        return typeof files.get(path) === "string"
          ? proxy({ content: files.get(path) })
          : fail(`The file “${path}” does not exist.`);
      }
      case "rename_file": {
        const source = params.get("source");
        const destination = params.get("destination");
        if (files.has(destination)) return fail("already exists");
        if (!files.has(source)) return fail("no such file");
        files.set(destination, files.get(source));
        files.delete(source);
        return proxy(null);
      }
      case "delete_file": {
        const path = params.get("path");
        const hit = [...files.keys()].filter(
          (p) => p === path || p.startsWith(`${path}/`),
        );
        if (hit.length === 0)
          return fail(`The system cannot find the file “${path}”.`);
        for (const p of hit) files.delete(p);
        deleted.push(path);
        return proxy({ path });
      }
      default:
        return proxy(null);
    }
  };
  const uapi = (params) => {
    if (params.get("cpanel.user") !== "wptest")
      throw new Error("uapi_cpanel for another account");
    const module = params.get("cpanel.module");
    const fn = params.get("cpanel.function");
    if (module === "Variables" && fn === "get_user_information")
      return proxy({ home: "/home/wptest" });
    if (module === "DomainInfo" && fn === "domains_data")
      return proxy({
        main_domain: {
          domain: "wp.example.test",
          documentroot: "/home/wptest/public_html",
          homedir: "/home/wptest",
        },
        addon_domains: [],
        sub_domains: [],
        parked_domains: [],
      });
    if (module === "Fileman") return fileman(fn, params);
    return proxy(null);
  };
  const routes = {
    [`GET ${base}/json-api/listaccts`]: () =>
      whmOk("listaccts", {
        acct: [{ user: "wptest", domain: "wp.example.test", suspended: 0 }],
      }),
    [`GET ${base}/json-api/verify_user_has_feature`]: () =>
      whmOk("verify_user_has_feature", {
        has_feature: 0,
        query_feature: "wp-toolkit",
      }),
    [`GET ${base}/json-api/uapi_cpanel`]: (url) => uapi(url.searchParams),
    [`POST ${base}/json-api/uapi_cpanel`]: (url, init) =>
      uapi(new URLSearchParams(String(init.body))),
    [`GET ${base}/json-api/create_user_session`]: (url) => {
      assert.equal(url.searchParams.get("user"), "wptest");
      assert.equal(url.searchParams.get("service"), "cpaneld");
      if (options.sessionRefusal !== undefined)
        return whmFail("create_user_session", options.sessionRefusal);
      return whmOk(
        "create_user_session",
        options.sessionData ?? {
          url: options.sessionUrl ?? SESSION_URL,
          session: `wptest:${SESSION_SECRET}`,
          cp_security_token: "/cpsess123",
          expires: 1_900_000_000,
          service: "cpaneld",
        },
      );
    },
    // The one-time login: a second use answers 401, as cPanel does.
    [LOGIN]: (url, init) => {
      session.logins++;
      if (
        session.logins > 1 ||
        url.searchParams.get("session") !== SESSION_SECRET
      )
        return [401, "<html>Access denied</html>", "text/html"];
      if (options.login) return options.login(url, init);
      session.cookie = COOKIE_VALUE;
      return [
        307,
        "",
        "text/html",
        [
          ["location", "/cpsess123/frontend/jupiter/index.html?login=1"],
          ["set-cookie", "cprelogin=no; HttpOnly; path=/; port=2083; secure"],
          [
            "set-cookie",
            `cpsession=${COOKIE_VALUE}; HttpOnly; path=/; port=2083; secure`,
          ],
          [
            "set-cookie",
            "roundcube_sessid=expired; HttpOnly; path=/; port=2083",
          ],
        ],
      ];
    },
    [SESSION_UPLOAD]: async (url, init) => {
      if (
        session.cookie === undefined ||
        init.headers?.cookie !== `cpsession=${session.cookie}`
      )
        return [401, "<html>Access denied</html>", "text/html"];
      if (options.upload) {
        const answer = await options.upload(url, init);
        if (answer) return answer;
      }
      const form = init.body;
      assert.ok(form instanceof FormData);
      assert.equal(form.get("overwrite"), "0");
      const file = form.get("file-1");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const path = `${form.get("dir")}/${file.name}`;
      if (files.has(path))
        return [
          200,
          {
            status: 1,
            data: {
              succeeded: 0,
              failed: 1,
              uploads: [{ status: 0, file: file.name, reason: "exists" }],
            },
          },
        ];
      files.set(
        path,
        /\.php(\.part)?$/.test(file.name)
          ? new TextDecoder().decode(bytes)
          : bytes,
      );
      return [
        200,
        {
          status: 1,
          errors: null,
          data: {
            succeeded: 1,
            failed: 0,
            uploads: [{ status: 1, file: file.name, size: bytes.length }],
          },
        },
      ];
    },
    [LOGOUT]: (url, init) => {
      session.logouts++;
      assert.equal(url.searchParams.get("locale"), "en");
      if (options.logout) return options.logout(url, init);
      if (init.headers?.cookie === `cpsession=${session.cookie}`)
        session.cookie = undefined;
      return [200, "<html>Logged out</html>", "text/html"];
    },
  };
  const site = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "license.dynamic.ooo")
      return new Response(ZIP, {
        headers: { "content-type": "application/zip" },
      });
    assert.equal(
      url.href,
      "https://wp.example.test/.well-known/oauth-protected-resource",
    );
    triggers.push(init);
    const installer = [...files.keys()].find((p) =>
      /^public_html\/wp-content\/mu-plugins\/novamira-hq-setup-[0-9a-f-]{36}\.php$/.test(
        p,
      ),
    );
    if (installer) {
      const slug = installer.split("/").pop().slice(0, -4);
      files.set(
        `public_html/wp-content/${slug}/status.json`,
        JSON.stringify({ ok: true, version: "1.12.8", aiEnabled: true }),
      );
      files.delete(installer);
      files.delete(`public_html/wp-content/${slug}/novamira.zip`);
    }
    return new Response("{}", { status: 404 });
  };
  return { files, deleted, triggers, session, routes, site };
}

/** The bare account's client, with every HTTP diagnostic recorded. */
function bareClient(account, options = {}) {
  const diagnostics = [];
  const fixture = whmFixture(account.routes, {
    transferFetch: account.site,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...options,
  });
  return { ...fixture, diagnostics };
}

const generatedFiles = (account) =>
  [...account.files.keys()].filter((p) => p.includes("novamira-hq-setup-"));
const key = (call) => `${call.method} ${call.url.origin}${call.url.pathname}`;
const uploadsOf = (calls) =>
  calls.filter((call) => key(call) === SESSION_UPLOAD);
const deletesOf = (calls) =>
  calls.filter(
    (call) =>
      call.url.pathname === "/json-api/uapi_cpanel" &&
      call.url.searchParams.get("cpanel.function") === "delete_file",
  );

test("the temporary installer on WHM uploads through a short-lived cPanel session on the WHM host, then logs it out", async () => {
  const account = bareWhm();
  const { client, calls, diagnostics } = bareClient(account);
  const result = await setup(client, { allowTemporaryInstaller: true });
  assert.equal(result.provider, "whm");
  assert.deepEqual(result.raw, {
    siteUrl: "https://wp.example.test/",
    version: "1.12.8",
    aiEnabled: true,
    warnings: [],
  });
  // HQ never goes to the host in the returned URL.
  assert.ok(calls.every((call) => call.url.hostname === "whm.example.test"));
  const order = calls.map(key);
  const opened = order.indexOf(`GET ${BASE}/json-api/create_user_session`);
  const login = order.indexOf(LOGIN);
  const firstUpload = order.indexOf(SESSION_UPLOAD);
  const lastUpload = order.lastIndexOf(SESSION_UPLOAD);
  const logout = order.indexOf(LOGOUT);
  assert.ok(opened >= 0 && opened < login && login < firstUpload);
  assert.ok(lastUpload < logout);
  assert.equal(order.filter((entry) => entry === LOGIN).length, 1);
  assert.equal(order.filter((entry) => entry === LOGOUT).length, 1);
  assert.equal(order.at(-1), LOGOUT);
  // The login: not followed, no WHM token, only the session query.
  const loginCall = calls[login];
  assert.equal(loginCall.redirect, "manual");
  assert.equal(loginCall.authorization, null);
  assert.equal(loginCall.cookie, null);
  assert.deepEqual([...loginCall.url.searchParams.keys()], ["session"]);
  // Four uploads, each with the session cookie alone.
  const uploads = uploadsOf(calls);
  assert.equal(uploads.length, 4);
  for (const call of [...uploads, calls[logout]]) {
    assert.equal(call.cookie, `cpsession=${COOKIE_VALUE}`);
    assert.equal(call.authorization, null);
  }
  assert.deepEqual(
    uploads.map((call) =>
      call.body
        .get("file-1")
        .name.replace(/novamira-hq-setup-[0-9a-f-]{36}/, "<slug>"),
    ),
    [".htaccess", "index.php", "novamira.zip", "<slug>.php.part"],
  );
  assert.equal(account.session.cookie, undefined);
  // Everything else is WHM with its token, and never carries the cookie.
  for (const call of calls.filter((call) => call.url.origin === BASE)) {
    assert.equal(call.authorization, `whm root:${TOKEN}`);
    assert.equal(call.cookie, null);
  }
  // The rename went through the proxy; the installer's files are gone.
  assert.ok(
    calls.some(
      (call) =>
        key(call) === `POST ${BASE}/json-api/uapi_cpanel` &&
        new URLSearchParams(String(call.body)).get("cpanel.function") ===
          "rename_file",
    ),
  );
  assert.equal(account.triggers.length, 1);
  assert.deepEqual(generatedFiles(account), []);
  assertNoSessionSecrets(result, "result");
  assertNoSessionSecrets(diagnostics, "diagnostics");
});

test("behind a proxy on port 443 the session still goes to the WHM host on port 2083", async () => {
  const base = "https://whm.example.test";
  const account = bareWhm({ base });
  const { client, calls } = bareClient(account, { baseUrl: base });
  await setup(client, { allowTemporaryInstaller: true });
  const login = calls.find((call) => call.url.pathname === "/cpsess123/login/");
  assert.equal(
    `${login.url.origin}${login.url.pathname}`,
    "https://whm.example.test:2083/cpsess123/login/",
  );
  assert.equal(uploadsOf(calls).length, 4);
});

test("a session URL WHM returns in another shape stops setup before any login or upload", async () => {
  const sessions = [
    {
      url: `https://cpanel.other-host.test:2083/cpsess123/frontend/?session=${SESSION_SECRET}`,
    },
    {
      url: `https://cpanel.other-host.test:2083/x/login/?session=${SESSION_SECRET}`,
    },
    {
      url: `https://cpanel.other-host.test:2083/cpsess123/login/?session=${SESSION_SECRET}&extra=1`,
    },
    {
      url: `https://cpanel.other-host.test:2083/cpsess123/login/?session=${SESSION_SECRET}&session=again`,
    },
    { url: "https://cpanel.other-host.test:2083/cpsess123/login/" },
    { url: "https://cpanel.other-host.test:2083/cpsess123/login/?session=" },
    {
      url: `https://cpanel.other-host.test:2083/cpsess12a/login/?session=${SESSION_SECRET}`,
    },
    { url: `cpsess123/login/?session=${SESSION_SECRET}` },
    { url: 42 },
    { session: SESSION_SECRET },
  ];
  for (const sessionData of sessions) {
    const label = JSON.stringify(sessionData);
    const account = bareWhm({ sessionData });
    const { client, calls, diagnostics } = bareClient(account);
    await assert.rejects(
      setup(client, { allowTemporaryInstaller: true }),
      (error) => {
        assert.equal(error.code, "provider_error", label);
        assert.equal(error.message, SESSION_MESSAGE, label);
        assertNoSessionSecrets(error, label);
        return true;
      },
    );
    assert.ok(
      calls.every((call) => call.url.origin === BASE),
      label,
    );
    assert.equal(account.session.logins, 0, label);
    assert.equal(uploadsOf(calls).length, 0, label);
    assert.equal(account.session.logouts, 0, label);
    assert.deepEqual(generatedFiles(account), [], label);
    assertNoSessionSecrets(diagnostics, label);
  }
});

test("a WHM user without the create-user-session privilege is told which privilege to ask for", async () => {
  const account = bareWhm({
    sessionRefusal:
      "Permission denied: You do not have the required privileges to run “create_user_session”.",
  });
  const { client, calls } = bareClient(account);
  await assert.rejects(setup(client, { allowTemporaryInstaller: true }), {
    code: "provider_error",
    message:
      "This WHM user cannot open cPanel sessions, which the temporary installer needs. Ask the server owner to give it the create-user-session privilege (WHM » Edit Reseller Nameservers and Privileges). Nothing was uploaded.",
  });
  assert.equal(account.session.logins, 0);
  assert.equal(uploadsOf(calls).length, 0);
  assert.deepEqual(generatedFiles(account), []);
  // Any other refusal keeps WHM's own reason.
  const other = bareWhm({ sessionRefusal: "Session service is down" });
  await assert.rejects(
    setup(bareClient(other).client, { allowTemporaryInstaller: true }),
    { code: "provider_error", message: /Session service is down/ },
  );
});

test("a login that does not answer a redirect with the cpsession cookie stops setup before any upload, and cleanup still runs", async () => {
  const logins = [
    () => [401, `<html>Denied ${SESSION_SECRET}</html>`, "text/html"],
    () => [200, `<html>Login ${SESSION_SECRET}</html>`, "text/html"],
    () => [
      307,
      "",
      "text/html",
      [["set-cookie", "cprelogin=no; HttpOnly; path=/"]],
    ],
    () => [307, "", "text/html", [["set-cookie", "cpsession=; HttpOnly"]]],
    () => [307, "", "text/html", [["set-cookie", "cpsession=  ; HttpOnly"]]],
    () => [
      307,
      "",
      "text/html",
      [["set-cookie", `xcpsession=${COOKIE_VALUE}; HttpOnly`]],
    ],
  ];
  for (const [index, login] of logins.entries()) {
    const label = `login ${String(index)}`;
    const account = bareWhm({ login });
    const { client, calls, diagnostics } = bareClient(account);
    await assert.rejects(
      setup(client, { allowTemporaryInstaller: true }),
      (error) => {
        assert.equal(error.code, "provider_error", label);
        assert.equal(error.message, LOGIN_MESSAGE, label);
        assertNoSessionSecrets(error, label);
        return true;
      },
    );
    const login0 = calls.find((call) => key(call) === LOGIN);
    assert.equal(login0.authorization, null, label);
    assert.equal(uploadsOf(calls).length, 0, label);
    assert.equal(account.session.logouts, 0, label);
    // As on cPanel, the generated paths are removed after the failure.
    assert.equal(deletesOf(calls).length, 3, label);
    assert.deepEqual(generatedFiles(account), [], label);
    assertNoSessionSecrets(diagnostics, label);
  }
});

test("a cPanel port that cannot be reached at login or upload names the cPanel address, not the session", async () => {
  const unreachable = () => {
    throw new TypeError(`fetch failed ${SESSION_SECRET} /cpsess123`);
  };
  const badCertificate = () => {
    throw Object.assign(new TypeError(`fetch failed ${SESSION_SECRET}`), {
      cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    });
  };
  // Answers only when the request is given up, as a silent port does.
  const silent = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const cases = [
    ["login unreachable", { login: unreachable }, 0],
    ["login certificate", { login: badCertificate }, 0],
    ["login timeout", { login: silent }, 0],
    ["upload unreachable", { upload: unreachable }, 1],
    ["upload certificate", { upload: badCertificate }, 1],
  ];
  for (const [label, options, uploads] of cases) {
    const account = bareWhm(options);
    const { client, calls, diagnostics } = bareClient(account, {
      http: { timeoutMs: 50 },
    });
    await assert.rejects(
      setup(client, { allowTemporaryInstaller: true }),
      (error) => {
        assert.equal(error.code, "network_error", label);
        assert.equal(error.message, UNREACHABLE_MESSAGE, label);
        assertNoSessionSecrets(error, label);
        return true;
      },
    );
    assert.equal(uploadsOf(calls).length, uploads, label);
    // A session that opened is still logged out.
    assert.equal(account.session.logouts, uploads, label);
    assert.deepEqual(generatedFiles(account), [], label);
    assertNoSessionSecrets(diagnostics, label);
  }
});

test("a setup cancelled while the login is in flight is cancelled and logs out the session it opened", async () => {
  const controller = new AbortController();
  const account = bareWhm({
    login: (url, init) => {
      controller.abort();
      // A request on the caller's signal would be given up here.
      init.signal?.throwIfAborted();
      account.session.cookie = COOKIE_VALUE;
      return [
        307,
        "",
        "text/html",
        [
          [
            "set-cookie",
            `cpsession=${COOKIE_VALUE}; HttpOnly; path=/; port=2083; secure`,
          ],
        ],
      ];
    },
  });
  const { client, calls } = bareClient(account);
  await assert.rejects(
    setup(client, {
      allowTemporaryInstaller: true,
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error.code, "network_error");
      assert.equal(
        error.message,
        "Novamira setup was cancelled before the temporary installer was placed; nothing was installed.",
      );
      assertNoSessionSecrets(error, "login cancel");
      return true;
    },
  );
  assert.equal(account.session.logins, 1);
  assert.equal(uploadsOf(calls).length, 0);
  assert.equal(account.session.logouts, 1);
  const logout = calls.find((call) => key(call) === LOGOUT);
  assert.equal(logout.cookie, `cpsession=${COOKIE_VALUE}`);
  assert.equal(logout.authorization, null);
});

test("an upload the session refuses fails setup with the refusal, is never retried, and the session is still logged out", async () => {
  for (const status of [401, 403]) {
    const account = bareWhm({
      upload: () => [
        status,
        `<html>Denied ${COOKIE_VALUE}</html>`,
        "text/html",
      ],
    });
    const { client, calls, diagnostics } = bareClient(account, {
      retry: { maxAttempts: 3, initialDelayMs: 1 },
    });
    await assert.rejects(
      setup(client, { allowTemporaryInstaller: true }),
      (error) => {
        assert.equal(error.code, "provider_error");
        assert.equal(error.message, REFUSED_MESSAGE);
        assertNoSessionSecrets(error, String(status));
        return true;
      },
    );
    assert.equal(uploadsOf(calls).length, 1);
    assert.equal(account.session.logouts, 1);
    assert.equal(calls.map(key).at(-1), LOGOUT);
    assert.deepEqual(generatedFiles(account), []);
    assertNoSessionSecrets(diagnostics, String(status));
  }
  // cPanel's own error text never echoes the session back.
  const echo = bareWhm({
    upload: () => [
      200,
      {
        status: 0,
        errors: [`Upload failed for ${COOKIE_VALUE} at /cpsess123/execute`],
        data: null,
      },
    ],
  });
  const echoed = bareClient(echo);
  await assert.rejects(
    setup(echoed.client, { allowTemporaryInstaller: true }),
    (error) => {
      assert.equal(error.code, "provider_error");
      assert.match(error.message, /^cPanel Fileman::upload_files failed: /);
      assertNoSessionSecrets(error, "echo");
      return true;
    },
  );
  assert.equal(echo.session.logouts, 1);
  // A server failure is not retried either and keeps no session detail.
  const busy = bareWhm({
    upload: () => [503, { error: `busy ${COOKIE_VALUE} /cpsess123` }],
  });
  const { client, calls } = bareClient(busy, {
    retry: { maxAttempts: 3, initialDelayMs: 1 },
  });
  await assert.rejects(
    setup(client, { allowTemporaryInstaller: true }),
    (error) => {
      assert.equal(error.retryable, false);
      assertNoSessionSecrets(error, "503");
      return true;
    },
  );
  assert.equal(uploadsOf(calls).length, 1);
  assert.equal(busy.session.logouts, 1);
});

test("a setup cancelled during the first upload is reported as cancelled and the session is logged out, even when logout fails", async () => {
  for (const logout of [
    undefined,
    () => {
      throw new Error(`logout broke ${COOKIE_VALUE}`);
    },
    () => [500, { error: "logout failed" }],
  ]) {
    const controller = new AbortController();
    const account = bareWhm({
      logout,
      upload: (url, init) => {
        controller.abort();
        init.signal.throwIfAborted();
      },
    });
    const { client, calls } = bareClient(account);
    await assert.rejects(
      setup(client, {
        allowTemporaryInstaller: true,
        signal: controller.signal,
      }),
      (error) => {
        assert.equal(error.code, "network_error");
        assert.equal(
          error.message,
          "Novamira setup was cancelled before the temporary installer was placed; nothing was installed.",
        );
        assertNoSessionSecrets(error, "cancel");
        return true;
      },
    );
    assert.equal(uploadsOf(calls).length, 1);
    // A logout that fails is tried once more, then given up.
    assert.equal(account.session.logouts, logout === undefined ? 1 : 2);
    const logoutCall = calls.find((call) => key(call) === LOGOUT);
    assert.equal(logoutCall.cookie, `cpsession=${COOKIE_VALUE}`);
    assert.equal(logoutCall.authorization, null);
  }
});

test("a logout that fails after a successful setup does not change its result", async () => {
  const account = bareWhm({
    logout: () => {
      throw new Error("connection reset");
    },
  });
  const { client } = bareClient(account);
  const result = await setup(client, { allowTemporaryInstaller: true });
  assert.equal(result.raw.version, "1.12.8");
  assert.equal(account.session.logouts, 2);
});

/** What undici throws when it reuses a keep-alive socket cpsrvd closed. */
const deadSocket = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    }),
  });

test("a logout that meets a closed keep-alive connection is sent once more and ends the session", async () => {
  let attempts = 0;
  const account = bareWhm({
    logout: (url, init) => {
      attempts++;
      if (attempts === 1) throw deadSocket();
      assert.equal(init.headers?.cookie, `cpsession=${COOKIE_VALUE}`);
      account.session.cookie = undefined;
      return [200, "<html>Logged out</html>", "text/html"];
    },
  });
  const { client, calls, diagnostics } = bareClient(account);
  const result = await setup(client, { allowTemporaryInstaller: true });
  assert.equal(result.raw.version, "1.12.8");
  const logouts = calls.filter((call) => key(call) === LOGOUT);
  assert.equal(logouts.length, 2);
  for (const call of logouts) {
    assert.equal(call.cookie, `cpsession=${COOKIE_VALUE}`);
    assert.equal(call.authorization, null);
  }
  assert.equal(account.session.cookie, undefined);
  assert.equal(calls.map(key).at(-1), LOGOUT);
  assertNoSessionSecrets(result, "result");
  assertNoSessionSecrets(diagnostics, "diagnostics");
});

test("a logout that fails twice is given up quietly and the setup result stands", async () => {
  const account = bareWhm({
    logout: () => {
      throw deadSocket();
    },
  });
  const { client, calls, diagnostics } = bareClient(account);
  const result = await setup(client, { allowTemporaryInstaller: true });
  assert.deepEqual(result.raw, {
    siteUrl: "https://wp.example.test/",
    version: "1.12.8",
    aiEnabled: true,
    warnings: [],
  });
  assert.equal(calls.filter((call) => key(call) === LOGOUT).length, 2);
  assertNoSessionSecrets(result, "result");
  assertNoSessionSecrets(diagnostics, "diagnostics");
});

test("a logout cPanel answers with its HTML page is not sent again", async () => {
  const account = bareWhm();
  const { client, calls } = bareClient(account);
  await setup(client, { allowTemporaryInstaller: true });
  assert.equal(calls.filter((call) => key(call) === LOGOUT).length, 1);
  assert.equal(account.session.cookie, undefined);
});

test("a cPanel setup failure after the uploads still logs the session out and keeps its own error", async () => {
  const account = bareWhm({
    logout: () => {
      throw new Error("logout broke");
    },
  });
  const rename = account.routes[`POST ${BASE}/json-api/uapi_cpanel`];
  account.routes[`POST ${BASE}/json-api/uapi_cpanel`] = (url, init) =>
    new URLSearchParams(String(init.body)).get("cpanel.function") ===
    "rename_file"
      ? whmOk("uapi_cpanel", {
          uapi: { status: 0, errors: ["Permission denied"], data: null },
        })
      : rename(url, init);
  const { client, calls } = bareClient(account);
  await assert.rejects(setup(client, { allowTemporaryInstaller: true }), {
    code: "provider_error",
    message: "cPanel Fileman::rename_file failed: Permission denied",
  });
  assert.equal(uploadsOf(calls).length, 4);
  assert.equal(account.session.logouts, 2);
  assert.equal(account.triggers.length, 0);
});

test("one session serves every upload, closing is idempotent, and nothing reopens it", async () => {
  const account = bareWhm();
  const { calls, context } = whmFixture(account.routes);
  const open = sessionUploads(context, createWhmApi(context));
  const body = (name) => ({
    kind: "multipart",
    fields: { dir: "public_html/x", overwrite: "0" },
    files: [
      {
        field: "file-1",
        filename: name,
        contentType: "text/plain",
        bytes: new Uint8Array([1]),
      },
    ],
  });
  // Closing a session that never opened sends nothing.
  const idle = open("wptest");
  await idle.close();
  assert.deepEqual(calls, []);
  const channel = open("wptest");
  const results = await Promise.all([
    channel.multipart("Fileman", "upload_files", body("a.txt")),
    channel.multipart("Fileman", "upload_files", body("b.txt")),
  ]);
  assert.deepEqual(
    results.map((data) => data.uploads[0].file),
    ["a.txt", "b.txt"],
  );
  assert.equal(account.session.logins, 1);
  await channel.close();
  await channel.close();
  assert.equal(account.session.logouts, 1);
  const before = calls.length;
  await assert.rejects(
    channel.multipart("Fileman", "upload_files", body("c.txt")),
    {
      code: "provider_error",
      message: "The temporary cPanel session is closed. Nothing was uploaded.",
    },
  );
  assert.equal(calls.length, before);
  assertNoSessionSecrets(results, "results");
});

test("operations other than setup never open a cPanel session", async () => {
  const account = bareWhm();
  const { client, calls } = bareClient(account);
  await client.getSite(ENV);
  await client.read({ kind: "backups", envId: ENV });
  assert.ok(calls.every((call) => call.url.origin === BASE));
  assert.ok(
    calls.every((call) => !call.url.pathname.includes("create_user_session")),
  );
});

/* -------------------------------------------------------------------------- */
/* Provisioning                                                               */
/* -------------------------------------------------------------------------- */

function provisioning(client, extra = {}) {
  const reports = [];
  return {
    reports,
    dependencies: {
      client,
      hostingProfile: "server",
      environment: {},
      fetch: async () => {
        throw new Error("offline");
      },
      report: (level, message) => reports.push([level, message]),
      ...extra,
    },
  };
}

test("provisioning treats WHM as a provider-API setup and names it", async () => {
  const { state, routes } = toolkit();
  const { client } = whmFixture(routes, { transferFetch: zipFetch });
  const { dependencies, reports } = provisioning(client);
  const result = await provisionNovamira(dependencies, {
    envId: ENV,
    compatCheck: false,
  });
  assert.equal(result.siteUrl, "https://wp.example.test");
  assert.equal(result.plugin.version, "1.12.8");
  assert.equal(result.aiAbilities.enabled, true);
  assert.equal(result.aiAbilities.domain, "wp.example.test");
  assert.equal(result.ready, null);
  assert.equal(state.uploads, 1);
  assert.ok(
    reports.some(
      ([, message]) =>
        message ===
        "Installing Novamira through WHM on the selected cPanel account. Existing installations are never overwritten.",
    ),
  );
  await assert.rejects(
    provisionNovamira(dependencies, { envId: ENV, force: true }),
    (error) => {
      assert.equal(error.code, "usage_error");
      assert.match(error.message, /^WHM setup supports/);
      return true;
    },
  );
  assert.equal(state.uploads, 1);
});

test("provisioning accepts the temporary installer approval for a WHM account and checks readiness afterwards", async () => {
  // With WP Toolkit the approval is simply not used.
  const withToolkit = toolkit();
  const first = provisioning(
    whmFixture(withToolkit.routes, { transferFetch: zipFetch }).client,
  );
  const done = await provisionNovamira(first.dependencies, {
    envId: ENV,
    compatCheck: false,
    temporaryInstaller: true,
  });
  assert.equal(done.plugin.version, "1.12.8");
  assert.equal(withToolkit.state.uploads, 1);
  // Without it, the approval reaches the provider as a consent for the
  // installer, which then runs through the temporary cPanel session.
  const bare = bareWhm();
  const requests = [];
  const { client } = bareClient(bare);
  const spy = {
    provider: client.provider,
    action: (request) => {
      requests.push(request);
      return client.action(request);
    },
  };
  const second = provisioning(spy);
  await assert.rejects(
    provisionNovamira(second.dependencies, {
      envId: ENV,
      compatCheck: false,
    }),
    { code: "confirmation_required" },
  );
  const installed = await provisionNovamira(second.dependencies, {
    envId: ENV,
    compatCheck: false,
    temporaryInstaller: true,
  });
  assert.equal(installed.siteUrl, "https://wp.example.test");
  assert.equal(installed.plugin.version, "1.12.8");
  assert.equal(installed.aiAbilities.enabled, true);
  assert.equal(installed.ready, null);
  assert.equal(Object.hasOwn(requests[0], "allowTemporaryInstaller"), false);
  assert.equal(requests[1].allowTemporaryInstaller, true);
  assert.equal(bare.session.logins, 1);
  assert.equal(bare.session.logouts, 1);
  assertNoSessionSecrets(installed, "provisioning result");
  assertNoSessionSecrets(second.reports, "provisioning reports");
});

test("the temporary installer approval is still refused for other providers", async () => {
  const { client } = whmFixture({});
  const other = { ...client, provider: "plesk" };
  await assert.rejects(
    provisionNovamira(provisioning(other).dependencies, {
      envId: ENV,
      temporaryInstaller: true,
    }),
    {
      code: "usage_error",
      message:
        "The temporary installer approval applies only to cPanel accounts without WP Toolkit, directly or through WHM.",
    },
  );
});
