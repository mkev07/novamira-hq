// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { CliError } from "../dist/errors.js";
import { novamiraPluginRowsFromFiles } from "../dist/hosting/providers/cpanel-sites.js";
import { setupWithInstaller } from "../dist/hosting/providers/cpanel-installer-setup.js";
import { createCpanelApi } from "../dist/hosting/providers/cpanel-uapi.js";
import { provisionNovamira } from "../dist/provisioning/setup.js";
import {
  DOMAINS_DATA,
  NO_TOOLKIT,
  TOKEN,
  USER,
  ZIP,
  cpanelFixture,
  ok,
} from "./helpers/cpanel-fixture.mjs";

const WPT = "/3rdparty/wpt/index.php";
const WP_CLI = `POST ${WPT}/v1/installations/1/features/wp-cli`;
const UPLOAD = `POST ${WPT}/v1/installations/1/features/uploader/plugins`;
const TASK = `GET ${WPT}/v1/background-tasks/install-custom-plugin/3`;
const ACTIVATE = `PUT ${WPT}/v1/installations/1/plugins/novamira/status`;
const INSTALLATIONS = `GET ${WPT}/v1/installations`;
const CACHE_CLEANER = `POST ${WPT}/v1/cache-cleaner`;
const REFRESH_TASK = `GET ${WPT}/v1/background-tasks/clear-installation-cache/7`;
const ENV = "domain:wp.example.test";

const INSTALL = {
  id: 1,
  url: "https://wp.example.test",
  version: "7.1.3",
  path: "/home/wptest/public_html",
  status: { alive: true, multisite: false },
};
const NOVAMIRA = { name: "novamira", status: "active", version: "1.12.8" };

const cliOk = (stdout) => [200, { exitCode: 0, stdout, stderr: "" }];
const zipFetch = async () =>
  new Response(ZIP, { headers: { "content-type": "application/zip" } });

/** WP Toolkit fake: plugin state, options and the WP-CLI argv it was sent. */
function toolkit(initial = null) {
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
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
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
          url: `${WPT}/v1/background-tasks/clear-installation-cache/7`,
          task: {
            id: 7,
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
        id: 7,
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
          url: `${WPT}/v1/background-tasks/install-custom-plugin/3`,
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

test("cPanel setup with WP Toolkit uploads the official ZIP, activates and enables AI Abilities", async () => {
  const { state, routes } = toolkit();
  const { client, calls } = cpanelFixture(routes, { transferFetch: zipFetch });
  const result = await setup(client);
  assert.equal(result.provider, "cpanel");
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
  // The multipart field names WP Toolkit 6.11.4 expects, and the exact ZIP.
  const file = state.form.get("file");
  assert.equal(file.name, "novamira.zip");
  assert.equal(file.type, "application/zip");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), ZIP);
  assert.deepEqual([...state.form.keys()].sort(), ["file", "status"]);
  // Every Toolkit request carries the cpanel header; none leaks the token.
  const toolkitCalls = calls.filter((call) =>
    call.url.pathname.startsWith(WPT),
  );
  assert.ok(toolkitCalls.length >= 8);
  assert.ok(
    toolkitCalls.every(
      (call) => call.authorization === `cpanel ${USER}:${TOKEN}`,
    ),
  );
  assert.ok(calls.every((call) => !call.url.href.includes(TOKEN)));
  // WP-CLI receives an argv array and `env: null`, never a shell string.
  assert.deepEqual(state.argv[0], ["eval", "echo PHP_VERSION;"]);
  assert.deepEqual(
    state.argv.find((argv) => argv[1] === "update"),
    ["option", "update", "novamira_ai_abilities_domain", "wp.example.test"],
  );
});

const REFRESH_FAILED =
  "WP Toolkit could not refresh this site's details. Check WP Toolkit in cPanel before retrying.";

test("WP Toolkit's cache for the installation is refreshed before the plugin read and any upload", async () => {
  for (const [label, plugin, writes] of [
    ["fresh install", null, ["upload"]],
    [
      "existing inactive Novamira",
      { ...NOVAMIRA, status: "inactive" },
      ["activate"],
    ],
    ["existing active Novamira", NOVAMIRA, []],
  ]) {
    const { state, routes } = toolkit(plugin);
    const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
    await setup(client, { enableAiAbilities: false });
    assert.deepEqual(state.refreshes, [{ installationsIds: [1] }], label);
    assert.equal(state.log[0], "refresh", label);
    assert.ok(
      state.log.indexOf("refresh") < state.log.indexOf("plugin list"),
      label,
    );
    for (const write of writes)
      assert.ok(state.log.indexOf("refresh") < state.log.indexOf(write), label);
    assert.equal(
      state.log.filter((entry) => entry === "refresh").length,
      1,
      label,
    );
  }
});

test("the cache refresh waits for its task on the install poll's 2 s interval", async () => {
  const { state, routes } = toolkit();
  let polls = 0;
  const original = routes[REFRESH_TASK];
  routes[REFRESH_TASK] = () => {
    polls++;
    return polls < 3
      ? [200, { id: 7, code: "clear-installation-cache", status: "running" }]
      : original();
  };
  const pauses = [];
  const { client } = cpanelFixture(routes, {
    transferFetch: zipFetch,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  await setup(client);
  assert.equal(polls, 3);
  assert.deepEqual(pauses, [2000, 2000]);
  // Nothing else ran while the refresh was pending.
  assert.equal(state.log[0], "refresh");
  assert.equal(state.uploads, 1);
});

test("a cache refresh that fails, is cancelled or never finishes stops setup before any read or upload", async () => {
  for (const status of ["error", "canceled"]) {
    const { state, routes } = toolkit();
    routes[REFRESH_TASK] = () => [
      200,
      {
        id: 7,
        code: "clear-installation-cache",
        status,
        errors: ["internal detail"],
      },
    ];
    const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
    await assert.rejects(setup(client), (error) => {
      assert.equal(error.code, "provider_error");
      assert.equal(error.message, REFRESH_FAILED);
      return true;
    });
    assert.deepEqual(state.log, ["refresh"], status);
    assert.equal(state.uploads, 0, status);
    assert.equal(state.options.size, 0, status);
  }
  const stuck = toolkit();
  let polls = 0;
  stuck.routes[REFRESH_TASK] = () => {
    polls++;
    return [
      200,
      { id: 7, code: "clear-installation-cache", status: "running" },
    ];
  };
  const pauses = [];
  const { client } = cpanelFixture(stuck.routes, {
    transferFetch: zipFetch,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  await assert.rejects(setup(client), {
    code: "provider_error",
    message: REFRESH_FAILED,
  });
  assert.equal(polls, 31);
  assert.equal(pauses.length, 30);
  assert.ok(pauses.every((ms) => ms === 2000));
  assert.deepEqual(stuck.state.log, ["refresh"]);
  assert.equal(stuck.state.uploads, 0);
});

test("a cache refresh answer that is not the expected task stops setup before any read or upload", async () => {
  for (const body of [
    {},
    { task: null },
    { task: { id: "7", code: "clear-installation-cache" } },
    { task: { id: 0, code: "clear-installation-cache" } },
    { task: { id: 7.5, code: "clear-installation-cache" } },
    { task: { id: 7, code: "install-custom-plugin" } },
    { task: { id: 7 } },
  ]) {
    const { state, routes } = toolkit();
    routes[CACHE_CLEANER] = () => [200, body];
    const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
    await assert.rejects(
      setup(client),
      { code: "provider_error", message: REFRESH_FAILED },
      JSON.stringify(body),
    );
    assert.deepEqual(state.log, [], JSON.stringify(body));
    assert.equal(state.uploads, 0);
  }
});

test("an HTTP failure of the cache refresh stops setup before any read or upload", async () => {
  for (const [status, code] of [
    [500, "provider_error"],
    [403, "credential_invalid"],
  ]) {
    const { state, routes } = toolkit();
    routes[CACHE_CLEANER] = () => [status, "no", "text/plain"];
    const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
    await assert.rejects(setup(client), { code }, String(status));
    assert.deepEqual(state.log, [], String(status));
    assert.equal(state.uploads, 0, String(status));
  }
});

test("the cache refresh polls the path for its own task and never follows the returned URL", async () => {
  for (const returned of [
    "https://attacker.example.test/3rdparty/wpt/index.php/v1/background-tasks/clear-installation-cache/7",
    "//attacker.example.test/steal",
    `${WPT}/v1/background-tasks/install-custom-plugin/9`,
    `${WPT}/v1/background-tasks/clear-installation-cache/7/../../9`,
    undefined,
  ]) {
    const { routes } = toolkit();
    const original = routes[CACHE_CLEANER];
    routes[CACHE_CLEANER] = async (url, init) => {
      const [status, body] = await original(url, init);
      return [status, { ...body, url: returned }];
    };
    const { client, calls } = cpanelFixture(routes, {
      transferFetch: zipFetch,
    });
    await setup(client);
    assert.ok(
      calls.every(
        (call) => call.url.origin === "https://cpanel.example.test:2083",
      ),
      String(returned),
    );
    assert.deepEqual(
      calls
        .filter((call) =>
          call.url.pathname.includes("clear-installation-cache"),
        )
        .map((call) => `${call.method} ${call.url.pathname}`),
      [REFRESH_TASK],
      String(returned),
    );
  }
});

test("a setup cancelled while the cache refresh runs stops before any read or upload", async () => {
  const { state, routes } = toolkit();
  const controller = new AbortController();
  routes[REFRESH_TASK] = () => [
    200,
    { id: 7, code: "clear-installation-cache", status: "running" },
  ];
  let sleeps = 0;
  const { client } = cpanelFixture(routes, {
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

test("the download goes to the official source with the label cPanel", async () => {
  const { routes } = toolkit();
  const requested = [];
  const { client } = cpanelFixture(routes, {
    transferFetch: async (url, init) => {
      requested.push([String(url), init.redirect]);
      return new Response(ZIP);
    },
  });
  await setup(client);
  assert.deepEqual(requested, [
    ["https://license.dynamic.ooo/api/novamira/download", "manual"],
  ]);
  const { client: failing } = cpanelFixture(toolkit().routes, {
    transferFetch: async () => new Response("no", { status: 503 }),
  });
  await assert.rejects(setup(failing), (error) => {
    assert.equal(error.code, "provider_error");
    assert.match(error.message, /^cPanel setup transfer failed \(HTTP 503\)/);
    return true;
  });
});

test("cPanel setup keeps an existing active Novamira and its AI settings", async () => {
  const { state, routes } = toolkit({ ...NOVAMIRA });
  const { client } = cpanelFixture(routes, {
    transferFetch: async () => {
      throw new Error("must not download");
    },
  });
  const result = await setup(client);
  assert.equal(result.raw.aiEnabled, null);
  assert.equal(result.raw.version, "1.12.8");
  assert.equal(state.uploads, 0);
  assert.equal(state.activations, 0);
  assert.equal(state.options.size, 0);
});

test("an existing Novamira is only rewritten when AI Abilities are asked for", async () => {
  const { state, routes } = toolkit({ ...NOVAMIRA });
  const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
  const result = await setup(client, { enableAiAbilities: true });
  assert.equal(result.raw.aiEnabled, true);
  assert.equal(state.uploads, 0);
  assert.equal(state.options.get("novamira_ai_abilities_enabled"), "1");
});

test("a fresh install can opt out of AI Abilities", async () => {
  const { state, routes } = toolkit();
  const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
  const result = await setup(client, { enableAiAbilities: false });
  assert.equal(result.raw.aiEnabled, null);
  assert.equal(state.uploads, 1);
  assert.equal(state.options.size, 0);
});

test("an inactive Novamira is activated through WP Toolkit, not reinstalled", async () => {
  const { state, routes } = toolkit({ ...NOVAMIRA, status: "inactive" });
  const { client } = cpanelFixture(routes, {
    transferFetch: async () => {
      throw new Error("must not download");
    },
  });
  const result = await setup(client);
  assert.equal(result.raw.aiEnabled, null);
  assert.equal(state.uploads, 0);
  assert.equal(state.activations, 1);
});

test("an activation WP Toolkit does not confirm fails setup", async () => {
  const { routes } = toolkit({ ...NOVAMIRA, status: "inactive" });
  routes[ACTIVATE] = () => [200, {}];
  const { client } = cpanelFixture(routes);
  await assert.rejects(setup(client), {
    code: "provider_error",
    message:
      "Novamira activation was not verified; check WordPress before retrying.",
  });
});

test("cPanel setup refuses an old Novamira, old PHP, old WordPress or a multisite install before writing", async () => {
  const cases = [
    [
      "old Novamira",
      { plugin: { name: "novamira", status: "active", version: "1.10.0" } },
      "server_unsupported",
    ],
    ["old PHP", { php: "7.4.33" }, "server_unsupported"],
    ["multisite", { multisite: true }, "server_unsupported"],
    ["old WordPress", { wordpress: "6.8.2" }, "server_unsupported"],
    ["not working", { alive: false }, "server_unsupported"],
  ];
  for (const [label, patch, code] of cases) {
    const { state, routes } = toolkit(patch.plugin ?? null);
    if (patch.php) state.php = patch.php;
    const status = {
      alive: patch.alive ?? true,
      multisite: patch.multisite ?? false,
    };
    routes[INSTALLATIONS] = () => [
      200,
      [{ ...INSTALL, version: patch.wordpress ?? INSTALL.version, status }],
    ];
    const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
    await assert.rejects(setup(client), { code }, label);
    assert.equal(state.uploads, 0, label);
    assert.equal(state.activations, 0, label);
    assert.equal(state.options.size, 0, label);
  }
  // The messages tell the user what to fix.
  const { routes } = toolkit();
  routes[INSTALLATIONS] = () => [
    200,
    [{ ...INSTALL, status: { alive: false, multisite: false } }],
  ];
  const { client } = cpanelFixture(routes);
  await assert.rejects(setup(client), {
    message: "The WP Toolkit installation is not working.",
  });
});

test("cPanel setup refuses an http, other-host or non-default-port site before writing anything, saying what is wrong", async () => {
  for (const [url, message] of [
    [
      "http://wp.example.test",
      "This site's WordPress address does not use HTTPS. Turn on HTTPS for the site, or install Novamira from WordPress → Plugins, then connect the site by URL.",
    ],
    [
      "https://wp.example.test:8443",
      "This site's WordPress address uses port 8443; cPanel setup supports only the default HTTPS port. Install Novamira from WordPress → Plugins, then connect the site by URL.",
    ],
    [
      "https://other.example.test",
      "This site's WordPress address is other.example.test, which is not this cPanel domain (wp.example.test). Install Novamira from WordPress → Plugins, then connect the site by URL.",
    ],
  ]) {
    const { state, routes } = toolkit();
    routes[INSTALLATIONS] = () => [200, [{ ...INSTALL, url }]];
    const { client, calls } = cpanelFixture(routes, {
      transferFetch: async () => {
        throw new Error("must not download");
      },
    });
    await assert.rejects(
      setup(client),
      { code: "provider_unsupported", message },
      url,
    );
    assert.equal(state.uploads, 0, url);
    assert.equal(state.options.size, 0, url);
    assert.deepEqual(state.argv, [], url);
    assert.ok(
      calls.every((call) => call.method === "GET"),
      url,
    );
  }
});

test("cPanel setup through WP Toolkit accepts a www WordPress address and uses its host for AI Abilities", async () => {
  const { state, routes } = toolkit();
  routes[INSTALLATIONS] = () => [
    200,
    [{ ...INSTALL, url: "https://www.wp.example.test" }],
  ];
  const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
  const result = await setup(client);
  assert.equal(result.raw.siteUrl, "https://www.wp.example.test/");
  assert.equal(result.raw.aiEnabled, true);
  assert.equal(
    state.options.get("novamira_ai_abilities_domain"),
    "www.wp.example.test",
  );
  assert.equal(state.uploads, 1);
});

test("an older WP Toolkit without the cache cleaner (HTTP 404) continues setup without the refresh", async () => {
  const { state, routes } = toolkit();
  routes[CACHE_CLEANER] = () => [404, "Not Found", "text/html"];
  const { client, calls } = cpanelFixture(routes, { transferFetch: zipFetch });
  const result = await setup(client);
  assert.equal(result.raw.version, "1.12.8");
  assert.equal(state.uploads, 1);
  assert.ok(
    calls.every(
      (call) => !call.url.pathname.includes("clear-installation-cache"),
    ),
  );
});

test("a changed WP-CLI response shape stops setup before any write", async () => {
  const shapes = [
    () => [500, { meta: { status: 500, message: "changed" } }],
    () => [200, { stdout: "8.2.34", stderr: "" }],
    () => [200, { exitCode: "0", stdout: "8.2.34", stderr: "" }],
    () => [200, { exitCode: 2, stdout: "", stderr: "boom" }],
    () => [200, { exitCode: 0, stdout: 8, stderr: "" }],
    () => [200, ["not", "an", "object"]],
    () => [404, "Not Found", "text/html"],
  ];
  for (const shape of shapes) {
    const { state, routes } = toolkit();
    routes[WP_CLI] = shape;
    const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
    await assert.rejects(setup(client), (error) => {
      assert.equal(error.code, "provider_error");
      assert.equal(
        error.message,
        "WP Toolkit did not confirm the command. Install Novamira from WordPress → Plugins, then connect the site by URL.",
      );
      return true;
    });
    assert.equal(state.uploads, 0);
  }
});

test("a rejected token on WP-CLI stays credential_invalid", async () => {
  const { routes } = toolkit();
  routes[WP_CLI] = () => [401, "Unauthorized", "text/plain"];
  const { client } = cpanelFixture(routes);
  await assert.rejects(setup(client), { code: "credential_invalid" });
});

test("a WP-CLI answer that is only busy keeps its retryable error, not the manual-setup text", async () => {
  for (const [status, code] of [
    [429, "rate_limited"],
    [502, "provider_error"],
    [503, "provider_error"],
    [504, "provider_error"],
  ]) {
    const { state, routes } = toolkit();
    routes[WP_CLI] = () => [status, "Try again later", "text/plain"];
    const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
    await assert.rejects(setup(client), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.retryable, true);
      assert.match(error.message, new RegExp(`HTTP ${String(status)}`));
      assert.doesNotMatch(error.message, /manual/i);
      return true;
    });
    assert.equal(state.uploads, 0);
  }
});

test("a plugin list that is not the expected JSON stops setup", async () => {
  for (const stdout of ["not json", "{}", '[{"name":"novamira"}]']) {
    const { state, routes } = toolkit();
    const original = routes[WP_CLI];
    routes[WP_CLI] = async (url, init) =>
      JSON.parse(String(init.body)).command[0] === "plugin"
        ? cliOk(stdout)
        : original(url, init);
    const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
    await assert.rejects(setup(client), { code: "provider_error" }, stdout);
    assert.equal(state.uploads, 0, stdout);
  }
});

test("a failed WP Toolkit background task fails setup", async () => {
  for (const status of ["error", "canceled"]) {
    const { routes } = toolkit();
    routes[TASK] = () => [200, { id: 3, status, errors: ["disk full"] }];
    const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
    await assert.rejects(setup(client), (error) => {
      assert.equal(error.code, "provider_error");
      assert.match(error.message, /could not install Novamira/);
      assert.ok(!error.message.includes("disk full"));
      return true;
    });
  }
});

test("setup waits for the background task and gives up after a bounded number of polls", async () => {
  const { state, routes } = toolkit();
  let polls = 0;
  const original = routes[TASK];
  routes[TASK] = () => {
    polls++;
    return polls < 4
      ? [200, { id: 3, status: "in_progress", errors: [] }]
      : original();
  };
  const pauses = [];
  const { client } = cpanelFixture(routes, {
    transferFetch: zipFetch,
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  const result = await setup(client);
  assert.equal(result.raw.version, "1.12.8");
  assert.equal(state.uploads, 1);
  assert.deepEqual(pauses, [2000, 2000, 2000]);

  const stuck = toolkit();
  let stuckPolls = 0;
  stuck.routes[TASK] = () => {
    stuckPolls++;
    return [200, { id: 3, status: "in_progress", errors: [] }];
  };
  const { client: waiting } = cpanelFixture(stuck.routes, {
    transferFetch: zipFetch,
  });
  await assert.rejects(setup(waiting), { code: "provider_error" });
  assert.equal(stuckPolls, 61);
});

test("an upload WP Toolkit does not accept as the install task fails setup", async () => {
  for (const body of [
    {},
    { task: { id: "3", code: "install-custom-plugin" } },
    { task: { id: 3, code: "something-else" } },
  ]) {
    const { routes } = toolkit();
    const upload = routes[UPLOAD];
    routes[UPLOAD] = async (url, init) => {
      await upload(url, init);
      return [200, body];
    };
    const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
    await assert.rejects(setup(client), {
      code: "provider_error",
      message: "WP Toolkit did not accept the Novamira upload.",
    });
  }
});

test("an install that the plugin list cannot confirm fails setup, and the upload is never repeated", async () => {
  const { state, routes } = toolkit();
  const original = routes[UPLOAD];
  routes[UPLOAD] = async (url, init) => {
    const response = await original(url, init);
    state.plugin = null;
    return response;
  };
  const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
  await assert.rejects(setup(client), {
    code: "provider_error",
    message:
      "Novamira installation was not verified; check WordPress before retrying.",
  });
  assert.equal(state.uploads, 1);
  assert.equal(state.options.size, 0);
});

test("AI Abilities settings that read back differently fail setup", async () => {
  const { state, routes } = toolkit();
  const original = routes[WP_CLI];
  routes[WP_CLI] = async (url, init) => {
    const command = JSON.parse(String(init.body)).command;
    return command[0] === "option" &&
      command[1] === "get" &&
      command[2] === "novamira_ai_abilities_enabled"
      ? cliOk("0")
      : original(url, init);
  };
  const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
  await assert.rejects(setup(client), {
    code: "provider_error",
    message: "Novamira AI Abilities settings were not verified.",
  });
  assert.equal(state.uploads, 1);
});

test("a cancelled setup stops before touching WP Toolkit", async () => {
  const { state, routes } = toolkit();
  const { client, calls } = cpanelFixture(routes, { transferFetch: zipFetch });
  await assert.rejects(setup(client, { signal: AbortSignal.abort() }));
  assert.deepEqual(calls, []);
  assert.equal(state.uploads, 0);
});

test("a setup cancelled while the install task runs stops polling", async () => {
  const { state, routes } = toolkit();
  const controller = new AbortController();
  routes[TASK] = () => [200, { id: 3, status: "in_progress", errors: [] }];
  let sleeps = 0;
  const { client } = cpanelFixture(routes, {
    transferFetch: zipFetch,
    sleep: async (ms, signal) => {
      sleeps++;
      controller.abort();
      signal.throwIfAborted();
    },
  });
  await assert.rejects(setup(client, { signal: controller.signal }));
  assert.equal(sleeps, 1);
  assert.equal(state.uploads, 1);
  assert.equal(state.options.size, 0);
});

test("setup on an unknown domain or without WP Toolkit changes nothing", async () => {
  const { state, routes } = toolkit();
  const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
  await assert.rejects(
    client.action({
      kind: "setup-novamira",
      envId: "domain:plain.example.test",
    }),
    { code: "not_found" },
  );
  await assert.rejects(
    client.action({ kind: "setup-novamira", envId: "wp.example.test" }),
    { code: "usage_error" },
  );
  assert.equal(state.uploads, 0);

  const bare = cpanelFixture(
    {
      ...NO_TOOLKIT,
      "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
      "GET /execute/Fileman/list_files": () =>
        ok([{ file: "wp-config.php", type: "file" }]),
      "GET /execute/Fileman/get_file_content": () => [
        200,
        { status: 0, errors: ["no"], data: null },
      ],
    },
    {
      transferFetch: async () => {
        throw new Error("must not download");
      },
    },
  );
  await assert.rejects(setup(bare.client), {
    code: "confirmation_required",
    message:
      "This cPanel account has no WP Toolkit. Novamira HQ can upload Novamira and a temporary installer that removes itself after one run. Ask the user to approve the temporary installer: in the dashboard tick the approval on the setup page; from the CLI add --temporary-installer; through MCP pass allowTemporaryInstaller only after the user approves. Or install Novamira from WordPress → Plugins.",
  });
  assert.ok(bare.calls.every((call) => call.method === "GET"));
});

test("cPanel advertises Novamira setup", async () => {
  const { client } = cpanelFixture();
  const capabilities = await client.read({ kind: "capabilities" });
  const entry = capabilities.find((item) => item.name === "novamira.setup");
  assert.equal(entry.supported, true);
  assert.equal(
    entry.notes,
    "Through WP Toolkit, or with your consent a temporary installer",
  );
});

test("the generic plugins read is not served by cPanel and sends no request", async () => {
  for (const routes of [
    toolkit({ ...NOVAMIRA }).routes,
    {
      ...NO_TOOLKIT,
      "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    },
  ]) {
    const { client, calls } = cpanelFixture(routes);
    await assert.rejects(client.read({ kind: "plugins", envId: ENV }), {
      code: "provider_unsupported",
      message: 'cPanel does not support the "plugins" read request.',
    });
    assert.deepEqual(calls, []);
  }
});

/** A file-reading cPanel API double for the Novamira-only detection helper. */
function filesApi({ plugins = [], header, listError } = {}) {
  const calls = [];
  return {
    calls,
    async uapi(module, fn, params) {
      calls.push([module, fn, params]);
      if (module !== "Fileman") throw new Error(`unexpected ${module}::${fn}`);
      if (fn === "list_files") {
        if (listError)
          throw new CliError(
            "provider_error",
            "cPanel Fileman::list_files failed: Permission denied",
          );
        return plugins.map((file) => ({ file, type: "dir" }));
      }
      if (fn === "get_file_content") {
        if (header === undefined)
          throw new CliError(
            "provider_error",
            "cPanel Fileman::get_file_content failed: missing",
          );
        return { content: header };
      }
      throw new Error(`unexpected ${module}::${fn}`);
    },
  };
}

test("without WP Toolkit Novamira is found in the plugin directories, never reported active or inactive", async () => {
  const none = filesApi({ plugins: ["akismet", "hello-dolly"] });
  assert.deepEqual(await novamiraPluginRowsFromFiles(none, "public_html"), []);
  assert.deepEqual(none.calls, [
    [
      "Fileman",
      "list_files",
      { dir: "public_html/wp-content/plugins", types: "dir" },
    ],
  ]);
  const present = filesApi({
    plugins: ["akismet", "novamira"],
    header:
      "<?php\n/**\n * Plugin Name: Novamira\n * Description: x\n * Version: 1.12.8\n * Author: Ovation\n */\n",
  });
  assert.deepEqual(await novamiraPluginRowsFromFiles(present, "public_html"), [
    { name: "novamira", status: "unknown", version: "1.12.8" },
  ]);
  assert.deepEqual(present.calls[1], [
    "Fileman",
    "get_file_content",
    { dir: "public_html/wp-content/plugins/novamira", file: "novamira.php" },
  ]);
});

test("without WP Toolkit a Novamira version that cannot be read is left out", async () => {
  for (const header of [
    undefined,
    "<?php\n// no header",
    "<?php\n * Version: banana",
  ]) {
    const api = filesApi({ plugins: ["novamira"], header });
    const rows = await novamiraPluginRowsFromFiles(api, "public_html");
    assert.deepEqual(rows, [{ name: "novamira", status: "unknown" }]);
  }
});

test("without WP Toolkit an unlistable plugin directory fails closed", async () => {
  await assert.rejects(
    novamiraPluginRowsFromFiles(filesApi({ listError: true }), "public_html"),
    { code: "provider_error" },
  );
});

test("provisioning treats cPanel as a provider-API setup and names it", async () => {
  const { state, routes } = toolkit();
  const { client } = cpanelFixture(routes, { transferFetch: zipFetch });
  const reports = [];
  const dependencies = {
    client,
    hostingProfile: "account",
    environment: {},
    fetch: async () => {
      throw new Error("offline");
    },
    report: (level, message) => reports.push([level, message]),
  };
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
        "Installing Novamira through cPanel. Existing installations are never overwritten.",
    ),
  );
  await assert.rejects(
    provisionNovamira(dependencies, { envId: ENV, force: true }),
    (error) => {
      assert.equal(error.code, "usage_error");
      assert.match(error.message, /^cPanel setup supports/);
      return true;
    },
  );
  assert.equal(state.uploads, 1);
});

/* -------------------------------------------------------------------------- */
/* Without WP Toolkit: the consented temporary installer                      */
/* -------------------------------------------------------------------------- */

const SETUP_NAME =
  /^novamira-hq-setup-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GENERATED_PATH =
  /^public_html\/wp-content\/(mu-plugins\/)?novamira-hq-setup-[0-9a-f-]{36}(\.php(\.part)?)?$/;

/**
 * Fake account without WP Toolkit over the Fileman calls verified on cPanel
 * 138; the site trigger runs the installer's outcome in JS.
 */
function bareAccount(options = {}) {
  const files = new Map(
    Object.entries({
      "public_html/wp-config.php": "<?php",
      "public_html/wp-includes/version.php": "<?php\n$wp_version = '7.1.3';\n",
      "public_html/.htaccess":
        options.htaccess ??
        "# BEGIN WordPress\nRewriteRule . /index.php [L]\n# END WordPress\n",
      ...(options.files ?? {}),
    }),
  );
  const deleted = [];
  const triggers = [];
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
      .map((file) => ({
        file,
        type,
        ...(options.mtime === null
          ? {}
          : { mtime: options.mtime ?? Math.floor(Date.now() / 1000) }),
      }));
  const routes = {
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    "GET /execute/Fileman/list_files": (url) =>
      ok(
        list(
          url.searchParams.get("dir"),
          url.searchParams.get("types") ?? "file",
        ),
      ),
    "GET /execute/Fileman/get_file_content": (url) => {
      const path = `${url.searchParams.get("dir")}/${url.searchParams.get("file")}`;
      return typeof files.get(path) === "string"
        ? ok({ content: files.get(path) })
        : [
            200,
            {
              status: 0,
              errors: [`The file “${path}” does not exist.`],
              data: null,
            },
          ];
    },
    "POST /execute/Fileman/upload_files": async (url, init) => {
      const form = init.body;
      assert.ok(form instanceof FormData);
      assert.equal(form.get("overwrite"), "0");
      const dir = form.get("dir");
      const file = form.get("file-1");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const path = `${dir}/${file.name}`;
      if (files.has(path))
        return ok({
          succeeded: 0,
          failed: 1,
          uploads: [{ status: 0, file: file.name, reason: "exists" }],
        });
      files.set(
        path,
        /\.php(\.part)?$/.test(file.name) || file.name === "lock"
          ? new TextDecoder().decode(bytes)
          : bytes,
      );
      return ok({
        succeeded: 1,
        failed: 0,
        uploads: [
          {
            status: 1,
            file: file.name,
            size: options.shortUpload === file.name ? 1 : bytes.length,
          },
        ],
      });
    },
    "POST /execute/Fileman/rename_file": (url, init) => {
      const form = new URLSearchParams(String(init.body));
      const source = form.get("source");
      const destination = form.get("destination");
      assert.equal(
        source.slice(0, source.lastIndexOf("/")),
        destination.slice(0, destination.lastIndexOf("/")),
      );
      if (files.has(destination))
        return [200, { status: 0, errors: ["already exists"], data: null }];
      if (!files.has(source))
        return [200, { status: 0, errors: ["no such file"], data: null }];
      files.set(destination, files.get(source));
      files.delete(source);
      return ok(null);
    },
    "GET /execute/Fileman/delete_file": (url) => {
      const path = url.searchParams.get("path");
      const hit = [...files.keys()].filter(
        (p) => p === path || p.startsWith(`${path}/`),
      );
      if (hit.length === 0)
        return [
          200,
          {
            status: 0,
            errors: [`The system cannot find the file “${path}”.`],
            data: null,
          },
        ];
      for (const p of hit) files.delete(p);
      deleted.push(path);
      return ok({ path });
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
      `https://${options.host ?? "wp.example.test"}/.well-known/oauth-protected-resource`,
    );
    triggers.push(init);
    if (options.served)
      return Response.json({
        resource: "https://wp.example.test/wp-json/mcp/novamira-oauth",
        novamira: { plugin_version: "1.12.8" },
      });
    const installer = [...files.keys()].find((p) =>
      /^public_html\/wp-content\/mu-plugins\/novamira-hq-setup-[0-9a-f-]{36}\.php$/.test(
        p,
      ),
    );
    if (installer && options.installerResult === "running") {
      // A run that took its lock and is still working: no status yet.
      const slug = installer.split("/").pop().slice(0, -4);
      files.set(`public_html/wp-content/${slug}/lock`, "");
    } else if (installer && options.installerResult !== "silent") {
      const slug = installer.split("/").pop().slice(0, -4);
      files.set(
        `public_html/wp-content/${slug}/status.json`,
        JSON.stringify(
          options.installerResult ?? {
            ok: true,
            version: "1.12.8",
            aiEnabled: true,
          },
        ),
      );
      files.delete(installer);
      files.delete(`public_html/wp-content/${slug}/novamira.zip`);
    }
    return new Response("{}", { status: 404 });
  };
  return { files, deleted, routes, site, triggers };
}

const installerSetup = (client, extra = {}) =>
  setup(client, { allowTemporaryInstaller: true, ...extra });

function setupFiles(account) {
  return [...account.files.keys()].filter((p) =>
    p.includes("novamira-hq-setup-"),
  );
}

function installerSource(calls) {
  const upload = calls.find(
    (call) =>
      call.url.pathname === "/execute/Fileman/upload_files" &&
      call.body.get("file-1").name.endsWith(".php.part"),
  );
  return upload.body
    .get("file-1")
    .arrayBuffer()
    .then((buffer) => {
      const source = new TextDecoder().decode(new Uint8Array(buffer));
      return JSON.parse(
        Buffer.from(
          /base64_decode\('([^']+)'\)/.exec(source)[1],
          "base64",
        ).toString(),
      );
    });
}

test("without WP Toolkit setup refuses until the temporary installer is approved, writing nothing", async () => {
  for (const extra of [{}, { allowTemporaryInstaller: false }]) {
    const account = bareAccount();
    const { client, calls } = cpanelFixture(account.routes, {
      transferFetch: account.site,
    });
    await assert.rejects(setup(client, extra), {
      code: "confirmation_required",
    });
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.ok(
      calls.every(
        (call) => call.url.pathname !== "/execute/Fileman/delete_file",
      ),
    );
    assert.equal(account.triggers.length, 0);
  }
});

test("the temporary installer uploads the ZIP, then the installer atomically, triggers once and removes only its own files", async () => {
  const account = bareAccount();
  const { client, calls } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  const result = await installerSetup(client);
  assert.deepEqual(result.raw, {
    siteUrl: "https://wp.example.test/",
    version: "1.12.8",
    aiEnabled: true,
    warnings: [],
  });
  const writes = calls.filter((call) => call.method === "POST");
  assert.deepEqual(
    writes.map((call) => call.url.pathname),
    [
      "/execute/Fileman/upload_files",
      "/execute/Fileman/upload_files",
      "/execute/Fileman/upload_files",
      "/execute/Fileman/upload_files",
      "/execute/Fileman/rename_file",
    ],
  );
  const [htaccess, index, zip, part, rename] = writes;
  const slug = zip.body.get("dir").split("/").pop();
  // The working directory refuses web access before the ZIP lands in it.
  for (const call of [htaccess, index])
    assert.equal(call.body.get("dir"), `public_html/wp-content/${slug}`);
  assert.equal(htaccess.body.get("file-1").name, ".htaccess");
  assert.equal(
    await htaccess.body.get("file-1").text(),
    "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n",
  );
  assert.equal(index.body.get("file-1").name, "index.php");
  assert.equal(await index.body.get("file-1").text(), "");
  assert.match(slug, SETUP_NAME);
  assert.equal(zip.body.get("dir"), `public_html/wp-content/${slug}`);
  assert.equal(zip.body.get("file-1").name, "novamira.zip");
  assert.deepEqual(
    new Uint8Array(await zip.body.get("file-1").arrayBuffer()),
    ZIP,
  );
  assert.equal(part.body.get("dir"), "public_html/wp-content/mu-plugins");
  assert.equal(part.body.get("file-1").name, `${slug}.php.part`);
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(String(rename.body))),
    {
      source: `public_html/wp-content/mu-plugins/${slug}.php.part`,
      destination: `public_html/wp-content/mu-plugins/${slug}.php`,
    },
  );
  // Every provider call carries the cPanel header; the site trigger none.
  assert.ok(
    calls.every((call) => call.authorization === `cpanel ${USER}:${TOKEN}`),
  );
  assert.equal(account.triggers.length, 1);
  const trigger = account.triggers[0];
  assert.equal(trigger.redirect, "manual");
  assert.deepEqual(
    Object.keys(trigger.headers)
      .map((key) => key.toLowerCase())
      .sort(),
    ["accept", "user-agent"],
  );
  assert.equal(new Headers(trigger.headers).get("accept"), "application/json");
  assert.match(
    new Headers(trigger.headers).get("user-agent"),
    /^novamira-hq\//,
  );
  // Cleanup removed exactly the generated paths and nothing else remains.
  assert.ok(account.deleted.length > 0);
  assert.ok(
    account.deleted.every((path) => GENERATED_PATH.test(path)),
    account.deleted.join(),
  );
  assert.ok(account.deleted.includes(`public_html/wp-content/${slug}`));
  assert.deepEqual(setupFiles(account), []);
  assert.ok(account.files.has("public_html/.htaccess"));
  // The installer carries only domain, digest, AI flag, minimum and its
  // lifetime, counted on the server from the file's own time.
  const config = await installerSource(calls);
  assert.deepEqual(Object.keys(config), [
    "domain",
    "digest",
    "enableAi",
    "minimumVersion",
    "ttl",
  ]);
  assert.equal(config.domain, "wp.example.test");
  assert.equal(config.digest, createHash("sha256").update(ZIP).digest("hex"));
  assert.equal(config.enableAi, true);
  assert.equal(config.minimumVersion, "1.11.1");
  assert.equal(config.ttl, 180);
});

/** Runs the installer path directly for a site discovery would not produce. */
function directInstaller(account, site) {
  const { calls, context } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  const run = setupWithInstaller(
    createCpanelApi(context),
    account.site,
    {
      domain: "wp.example.test",
      documentRoot: "public_html",
      version: "7.1.3",
      ...site,
    },
    { kind: "setup-novamira", envId: ENV, allowTemporaryInstaller: true },
    { sleep: async () => undefined, uuid: randomUUID, now: Date.now },
  );
  return { calls, run };
}

test("the temporary installer accepts a www WordPress address and checks that host", async () => {
  const account = bareAccount({ host: "www.wp.example.test" });
  const { calls, run } = directInstaller(account, {
    siteUrl: "https://www.wp.example.test/",
  });
  const result = await run;
  assert.equal(result.raw.siteUrl, "https://www.wp.example.test/");
  assert.equal((await installerSource(calls)).domain, "www.wp.example.test");
  assert.equal(account.triggers.length, 1);
  assert.deepEqual(setupFiles(account), []);
});

test("the temporary installer refuses another host before any write, naming it", async () => {
  const account = bareAccount({ host: "other.example.test" });
  const { calls, run } = directInstaller(account, {
    siteUrl: "https://other.example.test/",
  });
  await assert.rejects(run, {
    code: "provider_unsupported",
    message:
      "This site's WordPress address is other.example.test, which is not this cPanel domain (wp.example.test). Install Novamira from WordPress → Plugins, then connect the site by URL.",
  });
  assert.deepEqual(calls, []);
  assert.equal(account.triggers.length, 0);
});

test("provisioning passes the temporary installer approval through and checks readiness afterwards", async () => {
  const account = bareAccount();
  const { client } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  const dependencies = {
    client,
    hostingProfile: "account",
    environment: {},
    fetch: async () => {
      throw new Error("offline");
    },
  };
  await assert.rejects(
    provisionNovamira(dependencies, { envId: ENV, compatCheck: false }),
    {
      code: "confirmation_required",
    },
  );
  const result = await provisionNovamira(dependencies, {
    envId: ENV,
    compatCheck: false,
    temporaryInstaller: true,
  });
  assert.equal(result.plugin.version, "1.12.8");
  assert.equal(result.aiAbilities.enabled, true);
});

test("the temporary installer approval is refused for other providers", async () => {
  const { client } = cpanelFixture({});
  const other = { ...client, provider: "plesk" };
  await assert.rejects(
    provisionNovamira(
      {
        client: other,
        hostingProfile: "account",
        environment: {},
        fetch: async () => {
          throw new Error("offline");
        },
      },
      { envId: ENV, temporaryInstaller: true },
    ),
    {
      code: "usage_error",
      message:
        "The temporary installer approval applies only to cPanel accounts without WP Toolkit, directly or through WHM.",
    },
  );
});

test("an existing supported Novamira is only activated: no ZIP, no digest, AI settings kept by default", async () => {
  const account = bareAccount({
    installerResult: { ok: true, version: "1.12.8", aiEnabled: false },
    files: {
      "public_html/wp-content/plugins/novamira/novamira.php":
        "<?php\n/**\n * Plugin Name: Novamira\n * Version: 1.12.8\n */\n",
    },
  });
  const { client, calls } = cpanelFixture(account.routes, {
    transferFetch: async (input, init) => {
      assert.notEqual(new URL(String(input)).hostname, "license.dynamic.ooo");
      return account.site(input, init);
    },
  });
  const result = await installerSetup(client);
  assert.deepEqual(result.raw, {
    siteUrl: "https://wp.example.test/",
    version: "1.12.8",
    aiEnabled: null,
    warnings: [],
  });
  const uploads = calls
    .filter((call) => call.url.pathname === "/execute/Fileman/upload_files")
    .map((call) => call.body.get("file-1").name);
  // The protection files create the working directory; the installer makes
  // its own lock, so a lock there is evidence that it ran.
  assert.equal(uploads.length, 3);
  assert.deepEqual(uploads.slice(0, 2), [".htaccess", "index.php"]);
  assert.ok(!uploads.includes("novamira.zip"));
  assert.ok(!uploads.includes("lock"));
  const config = await installerSource(calls);
  assert.equal(config.digest, null);
  assert.equal(config.enableAi, false);
  assert.deepEqual(setupFiles(account), []);
  assert.ok(
    account.files.has("public_html/wp-content/plugins/novamira/novamira.php"),
  );
});

test("an existing Novamira the site already serves is left untouched when AI Abilities are not requested", async () => {
  const account = bareAccount({
    served: true,
    files: {
      "public_html/wp-content/plugins/novamira/novamira.php":
        "<?php\n/**\n * Plugin Name: Novamira\n * Version: 1.12.8\n */\n",
    },
  });
  const { client, calls } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  const result = await installerSetup(client);
  assert.deepEqual(result.raw, {
    siteUrl: "https://wp.example.test/",
    version: "1.12.8",
    aiEnabled: null,
    warnings: [],
  });
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.ok(
    calls.every((call) => call.url.pathname !== "/execute/Fileman/delete_file"),
  );
  assert.equal(account.triggers.length, 1);
  const probe = account.triggers[0];
  assert.equal(probe.redirect, "manual");
  assert.deepEqual(
    Object.keys(probe.headers)
      .map((key) => key.toLowerCase())
      .sort(),
    ["accept", "user-agent"],
  );
});

test("an existing Novamira the site does not serve yet is activated through the installer", async () => {
  const account = bareAccount({
    installerResult: { ok: true, version: "1.12.8", aiEnabled: false },
    files: {
      "public_html/wp-content/plugins/novamira/novamira.php":
        "<?php\n/**\n * Plugin Name: Novamira\n * Version: 1.12.8\n */\n",
    },
  });
  const { client, calls } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  const result = await installerSetup(client);
  assert.equal(result.raw.aiEnabled, null);
  // The readiness probe (404), then the installer trigger.
  assert.equal(account.triggers.length, 2);
  assert.ok(
    calls.some((call) => call.url.pathname === "/execute/Fileman/rename_file"),
  );
  assert.deepEqual(setupFiles(account), []);
});

test("an existing Novamira with AI Abilities requested always runs the installer", async () => {
  const account = bareAccount({
    served: true,
    files: {
      "public_html/wp-content/plugins/novamira/novamira.php":
        "<?php\n/**\n * Plugin Name: Novamira\n * Version: 1.12.8\n */\n",
    },
  });
  const { client, calls } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  // The served fake never writes status.json, so the run ends unreported.
  await assert.rejects(installerSetup(client, { enableAiAbilities: true }), {
    code: "provider_error",
  });
  assert.ok(calls.some((call) => call.method === "POST"));
  assert.deepEqual(setupFiles(account), []);
});

test("a rename cPanel refuses stops setup, cleans up and never triggers", async () => {
  const account = bareAccount();
  account.routes["POST /execute/Fileman/rename_file"] = () => [
    200,
    { status: 0, errors: ["already exists"], data: null },
  ];
  const { client } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  await assert.rejects(installerSetup(client), { code: "provider_error" });
  assert.equal(account.triggers.length, 0);
  assert.deepEqual(setupFiles(account), []);
  assert.ok(account.deleted.every((path) => GENERATED_PATH.test(path)));
});

test("an old or unreadable existing Novamira stops the temporary installer before any write", async () => {
  for (const [header, code] of [
    ["<?php\n * Version: 1.10.0\n", "server_unsupported"],
    ["<?php\n// no header\n", "provider_error"],
  ]) {
    const account = bareAccount({
      files: { "public_html/wp-content/plugins/novamira/novamira.php": header },
    });
    const { client, calls } = cpanelFixture(account.routes, {
      transferFetch: account.site,
    });
    await assert.rejects(installerSetup(client), { code });
    assert.ok(
      calls.every((call) => call.method === "GET"),
      code,
    );
    assert.equal(account.triggers.length, 0);
  }
});

test("plain permalinks stop the temporary installer before any upload", async () => {
  for (const htaccess of [
    "# BEGIN cPanel-generated php ini directives\n",
    undefined,
  ]) {
    const account = bareAccount({ htaccess: htaccess ?? "" });
    if (htaccess === undefined) account.files.delete("public_html/.htaccess");
    const { client, calls } = cpanelFixture(account.routes, {
      transferFetch: account.site,
    });
    await assert.rejects(installerSetup(client), {
      code: "provider_unsupported",
      message:
        "WordPress permalinks are off on this site, so the temporary installer cannot run. Turn on permalinks in WordPress → Settings → Permalinks, or install Novamira from WordPress → Plugins.",
    });
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.equal(account.triggers.length, 0);
  }
});

test("an installer that never reports is triggered once more, then cleaned up and reported", async () => {
  const account = bareAccount({ installerResult: "silent" });
  const sleeps = [];
  const { client } = cpanelFixture(account.routes, {
    transferFetch: account.site,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await assert.rejects(installerSetup(client), {
    code: "provider_error",
    message: NO_REPORT,
  });
  assert.equal(account.triggers.length, 2);
  assert.ok(sleeps.every((ms) => ms === 2000));
  // No lock or payload in the working directory: nothing ran, no extra wait.
  assert.equal(sleeps.length, 30);
  assert.deepEqual(setupFiles(account), []);
  assert.ok(account.deleted.every((path) => GENERATED_PATH.test(path)));
  // The installer is removed before the working directory is looked at.
  assert.match(
    account.deleted[0],
    /mu-plugins\/novamira-hq-setup-[0-9a-f-]{36}\.php$/,
  );
  assert.match(
    account.deleted.at(-1),
    /wp-content\/novamira-hq-setup-[0-9a-f-]{36}$/,
  );
});

const NO_REPORT =
  "The temporary installer did not report a result. It may have partly run; check Plugins in WordPress before retrying.";

test("an installer that started but has not reported is removed first, then given its lifetime before its directory goes", async () => {
  const account = bareAccount({ installerResult: "running" });
  const sleeps = [];
  const { client, calls } = cpanelFixture(account.routes, {
    transferFetch: account.site,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await assert.rejects(installerSetup(client), {
    code: "provider_error",
    message: NO_REPORT,
  });
  // 30 polls, then 90 more at 2 s: the installer's 180 s lifetime.
  assert.equal(sleeps.length, 120);
  assert.ok(sleeps.every((ms) => ms === 2000));
  const order = calls
    .filter(
      (call) =>
        call.url.pathname === "/execute/Fileman/delete_file" ||
        (call.url.pathname === "/execute/Fileman/list_files" &&
          SETUP_NAME.test(
            String(call.url.searchParams.get("dir")).split("/").pop(),
          )),
    )
    .map((call) =>
      call.url.pathname.endsWith("delete_file")
        ? `delete ${call.url.searchParams.get("path").split("/").pop()}`
        : "list",
    );
  assert.match(order[0], /^delete novamira-hq-setup-[0-9a-f-]{36}\.php$/);
  assert.equal(order.at(-1).startsWith("delete novamira-hq-setup-"), true);
  assert.ok(!order.at(-1).endsWith(".php"));
  assert.ok(order.indexOf("list") > 0);
  assert.ok(order.indexOf("list") < order.length - 1);
  assert.deepEqual(setupFiles(account), []);
});

test("a result that appears while HQ waits on a started installer is used", async () => {
  const account = bareAccount({ installerResult: "running" });
  const read = account.routes["GET /execute/Fileman/get_file_content"];
  let lateReads = 0;
  account.routes["GET /execute/Fileman/get_file_content"] = (url) => {
    const dir = url.searchParams.get("dir");
    const installerGone = ![...account.files.keys()].some((p) =>
      /mu-plugins\/novamira-hq-setup-[0-9a-f-]{36}\.php$/.test(p),
    );
    if (
      url.searchParams.get("file") === "status.json" &&
      installerGone &&
      ++lateReads === 3
    )
      account.files.set(
        `${dir}/status.json`,
        JSON.stringify({ ok: true, version: "1.12.8", aiEnabled: true }),
      );
    return read(url);
  };
  const sleeps = [];
  const { client } = cpanelFixture(account.routes, {
    transferFetch: account.site,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const result = await installerSetup(client);
  assert.equal(result.raw.version, "1.12.8");
  assert.equal(sleeps.length, 33);
  assert.deepEqual(setupFiles(account), []);
});

test("an installer failure is reported in plain words after cleanup", async () => {
  for (const [error, message] of [
    ["expired", "The temporary installer expired before WordPress ran it."],
    ["host", "The site's WordPress address does not match this domain."],
    ["requirements", "This site needs WordPress 6.9 and PHP 8.0 or newer."],
    ["multisite", "Novamira setup does not support WordPress multisite."],
    [
      "zip",
      "This site's PHP has no ZIP support; ask your host to enable the PHP zip extension, or install Novamira from WordPress → Plugins.",
    ],
    [
      "activation",
      "WordPress refused to activate Novamira; check Plugins in WordPress.",
    ],
    [
      "exists",
      "A Novamira folder appeared while setup was running; check Plugins in WordPress before retrying.",
    ],
    [
      "incomplete",
      "Novamira could not be installed completely; nothing was activated. Try again.",
    ],
    [
      "digest",
      "The Novamira package on the site does not match the download; nothing was installed. Try again.",
    ],
    [
      "brand_new",
      "The temporary installer could not install Novamira (brand_new).",
    ],
  ]) {
    const account = bareAccount({ installerResult: { ok: false, error } });
    const { client } = cpanelFixture(account.routes, {
      transferFetch: account.site,
    });
    await assert.rejects(installerSetup(client), {
      code: "provider_error",
      message,
    });
    assert.deepEqual(setupFiles(account), [], error);
  }
});

test("an upload cPanel does not confirm in full stops setup and cleans up without triggering", async () => {
  for (const name of ["novamira.zip", "part"]) {
    const account = bareAccount({ shortUpload: name });
    if (name === "part") {
      // The installer's generated name is only known once uploaded.
      const upload = account.routes["POST /execute/Fileman/upload_files"];
      account.routes["POST /execute/Fileman/upload_files"] = async (
        url,
        init,
      ) => {
        const answer = await upload(url, init);
        if (init.body.get("file-1").name.endsWith(".php.part"))
          answer[1].data.uploads[0].size = 3;
        return answer;
      };
    }
    const { client } = cpanelFixture(account.routes, {
      transferFetch: account.site,
    });
    await assert.rejects(installerSetup(client), { code: "provider_error" });
    assert.equal(account.triggers.length, 0, name);
    assert.deepEqual(setupFiles(account), [], name);
  }
});

test("a cleanup cPanel refuses becomes a warning naming the path", async () => {
  const account = bareAccount();
  const remove = account.routes["GET /execute/Fileman/delete_file"];
  account.routes["GET /execute/Fileman/delete_file"] = (url) =>
    SETUP_NAME.test(url.searchParams.get("path").split("/").pop())
      ? [200, { status: 0, errors: ["Permission denied"], data: null }]
      : remove(url);
  const { client } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  const result = await installerSetup(client);
  assert.equal(result.raw.warnings.length, 1);
  assert.match(
    result.raw.warnings[0],
    /public_html\/wp-content\/novamira-hq-setup-[0-9a-f-]{36}\b/,
  );
});

test("cleanup warnings are kept on the error when an upload or the rename throws", async () => {
  const failures = [
    [
      "the ZIP upload",
      { shortUpload: "novamira.zip" },
      "cPanel did not confirm the upload of novamira.zip. Nothing was installed.",
    ],
    [
      "the rename",
      {},
      "cPanel Fileman::rename_file failed: already exists",
      (account) => {
        account.routes["POST /execute/Fileman/rename_file"] = () => [
          200,
          { status: 0, errors: ["already exists"], data: null },
        ];
      },
    ],
  ];
  for (const [label, options, expected, tweak] of failures) {
    const account = bareAccount(options);
    tweak?.(account);
    const remove = account.routes["GET /execute/Fileman/delete_file"];
    account.routes["GET /execute/Fileman/delete_file"] = (url) =>
      SETUP_NAME.test(
        url.searchParams
          .get("path")
          .split("/")
          .pop()
          .replace(/\.php(\.part)?$/, ""),
      )
        ? [200, { status: 0, errors: ["Permission denied"], data: null }]
        : remove(url);
    const { client } = cpanelFixture(account.routes, {
      transferFetch: account.site,
    });
    await assert.rejects(installerSetup(client), (error) => {
      assert.equal(error.code, "provider_error", label);
      assert.ok(error.message.startsWith(expected), label);
      // Every path left behind is named, so the user can remove it by hand.
      const paths = [
        /public_html\/wp-content\/mu-plugins\/novamira-hq-setup-[0-9a-f-]{36}\.php\b(?!\.part)/,
        /public_html\/wp-content\/mu-plugins\/novamira-hq-setup-[0-9a-f-]{36}\.php\.part/,
        /public_html\/wp-content\/novamira-hq-setup-[0-9a-f-]{36}\b/,
      ];
      for (const path of paths) assert.match(error.message, path, label);
      assert.deepEqual(
        error.details.warnings.map((warning) =>
          warning.startsWith("Novamira HQ could not remove "),
        ),
        [true, true, true],
        label,
      );
      assert.ok(
        error.message.endsWith(error.details.warnings.join(" ")),
        label,
      );
      return true;
    });
    assert.equal(account.triggers.length, 0, label);
  }
});

test("an error without cleanup warnings is thrown as it is", async () => {
  const account = bareAccount({ shortUpload: "novamira.zip" });
  const { client } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  await assert.rejects(installerSetup(client), (error) => {
    assert.equal(
      error.message,
      "cPanel did not confirm the upload of novamira.zip. Nothing was installed.",
    );
    assert.equal(error.details?.warnings, undefined);
    return true;
  });
  assert.deepEqual(setupFiles(account), []);
});

test("a recent installer from another run blocks setup and is left alone", async () => {
  const other = "novamira-hq-setup-11111111-1111-4111-8111-111111111111";
  for (const name of [`${other}.php`, `${other}.php.part`]) {
    const account = bareAccount({
      files: {
        [`public_html/wp-content/mu-plugins/${name}`]: "<?php",
        [`public_html/wp-content/${other}/novamira.zip`]: "zip",
      },
    });
    const { client, calls } = cpanelFixture(account.routes, {
      transferFetch: account.site,
    });
    await assert.rejects(installerSetup(client), {
      code: "conflict",
      message:
        "Another Novamira setup is running on this site. Wait ten minutes, then try again.",
    });
    assert.ok(account.files.has(`public_html/wp-content/mu-plugins/${name}`));
    assert.deepEqual(account.deleted, []);
    assert.ok(calls.every((call) => call.method === "GET"));
  }
});

test("old leftovers are removed by exact name and nothing else is touched", async () => {
  const old = "novamira-hq-setup-22222222-2222-4222-8222-222222222222";
  const account = bareAccount({
    mtime: Math.floor(Date.now() / 1000) - 3600,
    files: {
      [`public_html/wp-content/${old}/status.json`]: "{}",
      [`public_html/wp-content/mu-plugins/${old}.php.part`]: "<?php",
      "public_html/wp-content/mu-plugins/novamira-hq-setup-notes.php": "<?php",
      "public_html/wp-content/mu-plugins/other.php": "<?php",
      "public_html/wp-content/novamira-hq-setup-notes/keep.txt": "x",
    },
  });
  const { client } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  await installerSetup(client);
  assert.ok(account.deleted.includes(`public_html/wp-content/${old}`));
  assert.ok(
    account.deleted.includes(
      `public_html/wp-content/mu-plugins/${old}.php.part`,
    ),
  );
  assert.ok(account.deleted.every((path) => GENERATED_PATH.test(path)));
  assert.ok(
    account.files.has(
      "public_html/wp-content/novamira-hq-setup-notes/keep.txt",
    ),
  );
  assert.ok(
    account.files.has(
      "public_html/wp-content/mu-plugins/novamira-hq-setup-notes.php",
    ),
  );
  assert.ok(account.files.has("public_html/wp-content/mu-plugins/other.php"));
});

test("a cancelled temporary installer setup still removes its files", async () => {
  const account = bareAccount({ installerResult: "silent" });
  const controller = new AbortController();
  const { client } = cpanelFixture(account.routes, {
    transferFetch: account.site,
    sleep: async () => {
      controller.abort();
      throw controller.signal.reason;
    },
  });
  await assert.rejects(
    installerSetup(client, { signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "network_error");
      assert.equal(
        error.message,
        "Novamira setup was cancelled after the temporary installer was placed, so its outcome on the site is unknown. Check Plugins in WordPress before retrying.",
      );
      return true;
    },
  );
  assert.equal(account.triggers.length, 1);
  assert.deepEqual(setupFiles(account), []);
});

test("a cancelled or timed-out installer setup names the paths it could not remove", async () => {
  for (const [label, interrupt, code, start] of [
    [
      "cancelled",
      (controller) => {
        controller.abort();
        throw controller.signal.reason;
      },
      "network_error",
      "Novamira setup was cancelled after the temporary installer was placed",
    ],
    [
      "timed out",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      "timeout",
      "Novamira setup ran out of time after the temporary installer was placed",
    ],
  ]) {
    const account = bareAccount({ installerResult: "silent" });
    account.routes["GET /execute/Fileman/delete_file"] = () => [
      200,
      { status: 0, errors: ["Permission denied"], data: null },
    ];
    const controller = new AbortController();
    const { client } = cpanelFixture(account.routes, {
      transferFetch: account.site,
      sleep: async () => interrupt(controller),
    });
    await assert.rejects(
      installerSetup(client, { signal: controller.signal }),
      (error) => {
        assert.ok(error instanceof CliError, label);
        assert.equal(error.code, code, label);
        assert.ok(error.message.startsWith(start), label);
        assert.equal(error.details.warnings.length, 3, label);
        assert.ok(
          error.message.endsWith(error.details.warnings.join(" ")),
          label,
        );
        return true;
      },
    );
  }
});

test("a setup cancelled before the installer is placed says nothing was installed", async () => {
  const account = bareAccount();
  const controller = new AbortController();
  const upload = account.routes["POST /execute/Fileman/upload_files"];
  account.routes["POST /execute/Fileman/upload_files"] = async (url, init) => {
    const answer = await upload(url, init);
    if (init.body.get("file-1").name === "novamira.zip") controller.abort();
    return answer;
  };
  const { client, calls } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  await assert.rejects(
    installerSetup(client, { signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "network_error");
      assert.equal(
        error.message,
        "Novamira setup was cancelled before the temporary installer was placed; nothing was installed.",
      );
      return true;
    },
  );
  assert.ok(
    calls.every(
      (call) =>
        call.url.pathname !== "/execute/Fileman/upload_files" ||
        !call.body.get("file-1").name.endsWith(".php.part"),
    ),
  );
  assert.equal(account.triggers.length, 0);
  assert.deepEqual(setupFiles(account), []);
});

test("the installer is built only after the ZIP upload succeeded", async () => {
  const account = bareAccount({ shortUpload: "novamira.zip" });
  const { client, calls } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  await assert.rejects(installerSetup(client), { code: "provider_error" });
  assert.ok(
    calls.every(
      (call) =>
        call.url.pathname !== "/execute/Fileman/upload_files" ||
        !call.body.get("file-1").name.endsWith(".php.part"),
    ),
  );
});

test("a WordPress older than 6.9, or one whose version cannot be read, stops the temporary installer before any write", async () => {
  for (const [version, code, message] of [
    [
      "6.8.2",
      "server_unsupported",
      "Novamira setup requires WordPress 6.9 or newer.",
    ],
    [
      undefined,
      "server_unsupported",
      "The WordPress version of this site could not be read; install Novamira from WordPress → Plugins, then connect the site by URL.",
    ],
  ]) {
    const account = bareAccount();
    if (version === undefined)
      account.files.delete("public_html/wp-includes/version.php");
    else
      account.files.set(
        "public_html/wp-includes/version.php",
        `<?php\n$wp_version = '${version}';\n`,
      );
    const { client, calls } = cpanelFixture(account.routes, {
      transferFetch: account.site,
    });
    await assert.rejects(installerSetup(client), { code, message });
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.ok(
      calls.every(
        (call) => call.url.pathname !== "/execute/Fileman/delete_file",
      ),
    );
    assert.equal(account.triggers.length, 0);
  }
});

test("a generated leftover without a modification time counts as a running setup", async () => {
  const other = "novamira-hq-setup-33333333-3333-4333-8333-333333333333";
  const account = bareAccount({
    mtime: null,
    files: { [`public_html/wp-content/${other}/status.json`]: "{}" },
  });
  const { client } = cpanelFixture(account.routes, {
    transferFetch: account.site,
  });
  await assert.rejects(installerSetup(client), { code: "conflict" });
  assert.deepEqual(account.deleted, []);
});
