// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { envCredential } from "../dist/config/schema.js";
import { SecretValue } from "../dist/credentials/resolve.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import { isHqPublicCapability } from "../dist/hosting/capabilities.js";
import { createXCloudClient } from "../dist/hosting/providers/xcloud.js";

const TOKEN = "123|xcloud-fake-token-not-a-secret";
const BASE = "https://xcloud.example.invalid/api/v1";
const TEAM_A = "11111111-1111-4111-8111-111111111111";
const TEAM_B = "22222222-2222-4222-8222-222222222222";
const SITE = "33333333-3333-4333-8333-333333333333";
const STAGING = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const TASK = "66666666-6666-4666-8666-666666666666";

function siteRow(uuid, name, extra = {}) {
  return {
    uuid,
    name,
    domain_name: name,
    type: "wordpress",
    status: "provisioned",
    deploy_state: "deployed",
    ...extra,
  };
}

function ok(data, status = 200) {
  return { status, body: { success: true, message: "Success", data } };
}

/**
 * A scripted xCloud: `routes` maps "METHOD /path" to a response (or a function
 * of the request). Every request is recorded with its team and credential.
 */
function fixture(routes = {}, options = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    const path = url.pathname.replace("/api/v1", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const call = {
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      team: headers.get("x-team-id"),
      authorization: headers.get("authorization"),
      body,
    };
    calls.push(call);
    const defaults = {
      "GET /teams": ok([
        { uuid: TEAM_A, name: "First", role: "owner", is_default: false },
        { uuid: TEAM_B, name: "Second", role: "owner", is_default: true },
      ]),
      "GET /user": ok({ uuid: "user", default_team_uuid: TEAM_B }),
    };
    const route = routes[`${method} ${path}`] ?? defaults[`${method} ${path}`];
    if (route === undefined) throw new Error(`Unexpected ${method} ${path}`);
    const response = typeof route === "function" ? route(call) : route;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createXCloudClient({
    provider: "xcloud",
    providerLabel: "xCloud",
    profileName: "test",
    profile: {
      provider: "xcloud",
      credential: envCredential("XCLOUD_API_TOKEN"),
    },
    baseUrl: BASE,
    secret: new SecretValue(TOKEN, "env", "env:XCLOUD_API_TOKEN"),
    credentialSource: "env:XCLOUD_API_TOKEN",
    companyId: options.team,
    identity: options.team,
    tokenUrl: undefined,
    env: {},
    createHttpClient(overrides = {}) {
      return createHttpClient({
        baseUrl: BASE,
        providerLabel: "xCloud",
        fetch,
        retry: { maxAttempts: 1 },
        ...overrides,
      });
    },
  });
  return { client, calls };
}

async function capabilities(client) {
  return Object.fromEntries(
    (await client.read({ kind: "capabilities" })).map((entry) => [
      entry.name,
      entry.supported,
    ]),
  );
}

test("xCloud publishes only HQ capabilities and never claims setup, push, restore or WP-CLI", async () => {
  const { client, calls } = fixture();
  const caps = await capabilities(client);
  for (const name of Object.keys(caps)) assert.ok(isHqPublicCapability(name));
  for (const name of [
    "novamira.setup",
    "envs.create",
    "envs.push",
    "backups.restore",
    "backups.downloadable",
    "wp-cli.run",
    "wp.plugins.install",
    "sites.create",
  ])
    assert.equal(caps[name], false, name);
  for (const name of [
    "sites.list",
    "envs.list",
    "backups.list",
    "backups.create",
    "cache.clear",
    "wp.plugins.update",
    "logs.get",
    "ops.wait",
  ])
    assert.equal(caps[name], true, name);
  assert.equal(client.wpCliResultsObservable(), false);
  assert.equal(calls.length, 0, "construction and capabilities stay offline");
});

test("xCloud without a team uses the first granted team on every request", async () => {
  const { client, calls } = fixture({
    "GET /sites": ok({
      items: [],
      pagination: { current_page: 1, last_page: 1 },
    }),
  });
  const validation = await client.validate();
  assert.equal(validation.companyId, TEAM_A);
  await client.listSites();
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["GET /teams", "GET /user", "GET /sites"],
    "the team is looked up once",
  );
  for (const call of calls) {
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
    if (call.path !== "/teams") assert.equal(call.team, TEAM_A);
  }
});

test("xCloud sends a configured team and refuses one the token was not granted", async () => {
  const granted = fixture({}, { team: TEAM_B.toUpperCase() });
  assert.equal((await granted.client.validate()).companyId, TEAM_B);
  assert.equal(granted.calls.find((c) => c.path === "/user").team, TEAM_B);

  const foreign = fixture({}, { team: OTHER });
  await assert.rejects(foreign.client.validate(), {
    code: "credential_invalid",
  });

  const malformed = fixture({}, { team: "not-a-team" });
  await assert.rejects(malformed.client.listSites(), { code: "usage_error" });
  assert.equal(malformed.calls.length, 0, "a malformed team never falls back");
});

test("xCloud lists WordPress sites and folds staging sites under production", async () => {
  const { client, calls } = fixture(
    {
      "GET /sites": (call) =>
        call.query.page === "1"
          ? ok({
              items: [
                siteRow(SITE, "example.com"),
                siteRow(STAGING, "staging.example.com"),
              ],
              pagination: { current_page: 1, last_page: 2 },
            })
          : ok({
              items: [
                siteRow(OTHER, "broken.example.com", {
                  deploy_state: "failed",
                }),
              ],
              pagination: { current_page: 2, last_page: 2 },
            }),
      [`GET /sites/${SITE}/staging-sites`]: ok({
        items: [
          {
            uuid: STAGING,
            name: "staging.example.com",
            environment: "staging",
          },
        ],
        count: 1,
      }),
      [`GET /sites/${STAGING}/staging-sites`]: {
        status: 422,
        body: { success: false, message: "This is not a production site." },
      },
      [`GET /sites/${OTHER}/staging-sites`]: ok({ items: [], count: 0 }),
    },
    { team: TEAM_A },
  );
  const sites = await client.listSites({ includeEnvironments: true });
  assert.deepEqual(
    sites.map((site) => [site.id, site.status]),
    [
      [SITE, "active"],
      [OTHER, "failed"],
    ],
  );
  assert.deepEqual(
    sites[0].environments.map((env) => [env.id, env.name, env.primaryDomain]),
    [
      [SITE, "live", "example.com"],
      [STAGING, "staging", "staging.example.com"],
    ],
  );
  const list = calls.filter((call) => call.path === "/sites");
  assert.deepEqual(
    list.map((call) => call.query),
    [
      { type: "wordpress", page: "1", per_page: "100" },
      { type: "wordpress", page: "2", per_page: "100" },
    ],
  );
  // Inventory never touches the SSH-backed WordPress status or log reads.
  assert.ok(
    calls.every(
      (call) =>
        !call.path.endsWith("/wordpress/status") &&
        !call.path.endsWith("/access-logs"),
    ),
  );
});

test("xCloud backups and cache purges return pollable site:task operations", async () => {
  const { client, calls } = fixture(
    {
      [`POST /sites/${SITE}/backup`]: ok({ task_uuid: TASK }),
      [`POST /sites/${SITE}/cache/purge`]: ok(
        { task_uuid: TASK, cloudflare_task_uuid: null },
        202,
      ),
      [`GET /sites/${SITE}/events/${TASK}`]: ok({
        uuid: TASK,
        name: "Backup",
        status: "failed",
        exit_code: 1,
        output: "server-private-output",
      }),
    },
    { team: TEAM_A },
  );
  const backup = await client.action({
    kind: "create-backup",
    envId: SITE,
    body: { tag: "before-update" },
  });
  assert.equal(backup.operationId, `${SITE}:${TASK}`);
  assert.deepEqual(
    calls.find((call) => call.path.endsWith("/backup")).body,
    { type: "local" },
    "xCloud backups carry no tag",
  );

  const purge = await client.action({
    kind: "clear-cache",
    cache: "site",
    body: { environment_id: SITE },
  });
  assert.equal(purge.operationId, `${SITE}:${TASK}`);
  await assert.rejects(
    client.action({
      kind: "clear-cache",
      cache: "edge",
      body: { environment_id: SITE },
    }),
    { code: "provider_unsupported" },
  );

  const status = await client.operationStatus(`${SITE}:${TASK}`);
  assert.equal(status.done, true);
  assert.equal(status.failed, true);
  assert.ok(!JSON.stringify(status).includes("server-private-output"));
  await assert.rejects(client.operationStatus(TASK), { code: "usage_error" });
});

test("xCloud updates only to the version it reports as available", async () => {
  const { client, calls } = fixture(
    {
      [`GET /sites/${SITE}/wordpress/plugins`]: ok({
        items: [{ slug: "akismet", available_version: "5.7.2" }],
        pagination: { current_page: 1, last_page: 1 },
      }),
      [`POST /sites/${SITE}/wordpress/update`]: ok(
        { operation: { uuid: TASK, status: "queued" } },
        202,
      ),
    },
    { team: TEAM_A },
  );
  await assert.rejects(
    client.action({
      kind: "update-plugin",
      envId: SITE,
      body: { name: "akismet", update_version: "9.9.9" },
    }),
    { code: "provider_unsupported" },
  );
  assert.ok(!calls.some((call) => call.method === "POST"));

  await client.action({
    kind: "update-plugin",
    envId: SITE,
    body: { name: "akismet", update_version: "5.7.2" },
  });
  await client.action({
    kind: "bulk-update-themes",
    envId: SITE,
    body: { themes: [] },
  });
  assert.deepEqual(
    calls.filter((call) => call.method === "POST").map((call) => call.body),
    [{ type: "plugin", slugs: ["akismet"] }, { type: "theme" }],
  );
});

test("xCloud refuses unsupported operations before any request", async () => {
  const { client, calls } = fixture({}, { team: TEAM_A });
  for (const request of [
    { kind: "setup-novamira", envId: SITE },
    { kind: "push-environment", siteId: SITE, body: {} },
    { kind: "restore-backup", targetEnvId: SITE, body: {} },
    { kind: "run-wp-cli", envId: SITE, body: { wp_command: "wp plugin list" } },
    { kind: "create-environment", siteId: SITE, mode: "clone", body: {} },
  ])
    await assert.rejects(client.action(request), {
      code: "provider_unsupported",
    });
  await assert.rejects(
    client.read({ kind: "logs", envId: SITE, fileName: "error", lines: 10 }),
    { code: "usage_error" },
  );
  await assert.rejects(client.read({ kind: "backups", envId: "1" }), {
    code: "usage_error",
  });
  assert.equal(calls.length, 0);
});

test("xCloud reads the access log with a bounded entry count", async () => {
  const { client, calls } = fixture(
    {
      [`GET /sites/${SITE}/access-logs`]: ok({ entries: [] }),
    },
    { team: TEAM_A },
  );
  await client.read({
    kind: "logs",
    envId: SITE,
    fileName: "access",
    lines: 5000,
  });
  assert.deepEqual(calls[0].query, { limit: "1000" });
});
