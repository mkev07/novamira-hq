// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../dist/errors.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import { renderHtml } from "../dist/web/html.js";
import { renderBackupCreate } from "../dist/web/views/backup-create.js";
import { waitForNewBackup } from "../dist/hosting/providers/cpanel-backups.js";
import { discoverWordPress } from "../dist/hosting/providers/cpanel-sites.js";
import {
  BASE,
  DOMAINS_DATA,
  NO_TOOLKIT,
  TOKEN,
  USER,
  VERSION_PHP,
  WP_HOME_URL,
  cpanelFixture,
  fileman,
  ok,
} from "./helpers/cpanel-fixture.mjs";

const LIST_DOMAINS = {
  "GET /execute/DomainInfo/list_domains": () =>
    ok({
      main_domain: "wp.example.test",
      addon_domains: [],
      sub_domains: [],
      parked_domains: [],
    }),
};

test("cPanel validates with list_domains and sends only the cpanel auth header", async () => {
  const { client, calls } = cpanelFixture(LIST_DOMAINS);
  assert.deepEqual(await client.validate(), {
    provider: "cpanel",
    status: "active",
    companyId: USER,
    credential: "env:CPANEL_API_TOKEN",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, `cpanel ${USER}:${TOKEN}`);
  assert.equal(calls[0].url.origin, BASE);
  assert.ok(!calls[0].url.href.includes(TOKEN));
});

test("cPanel requires an HTTPS panel URL at the root and a valid username", () => {
  for (const baseUrl of [
    "http://cpanel.example.test:2083",
    "https://user:pw@cpanel.example.test:2083",
    "https://cpanel.example.test:2083/frontend",
    "https://cpanel.example.test:2083/?x=1",
  ])
    assert.throws(() => cpanelFixture({}, { baseUrl }), {
      code: "config_error",
    });
  for (const user of ["Root", "1abc", "a b", "x".repeat(33), "../etc"])
    assert.throws(() => cpanelFixture({}, { user }), { code: "config_error" });
  assert.throws(() => cpanelFixture({}, { missingUser: true }), {
    code: "credential_missing",
  });
});

test("cPanel without a configured panel URL makes no request", async () => {
  const { client, calls } = cpanelFixture(LIST_DOMAINS, { missingUrl: true });
  await assert.rejects(client.validate(), { code: "config_error" });
  assert.deepEqual(calls, []);
});

test("cPanel reports a rejected token or username as credential_invalid", async () => {
  const { client } = cpanelFixture({
    "GET /execute/DomainInfo/list_domains": () => [
      403,
      "Access denied",
      "text/plain",
    ],
  });
  await assert.rejects(client.validate(), (error) => {
    assert.equal(error.code, "credential_invalid");
    assert.match(error.message, /username and API token/);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
});

test("cPanel explains certificate failures with the cpanel.<domain> alternative", async () => {
  const cause = Object.assign(new Error("self-signed certificate"), {
    code: "DEPTH_ZERO_SELF_SIGNED_CERT",
  });
  const { client } = cpanelFixture(
    {},
    { networkError: new TypeError("fetch failed", { cause }) },
  );
  await assert.rejects(client.validate(), (error) => {
    assert.equal(error.code, "network_error");
    assert.match(error.message, /certificate/);
    assert.match(error.message, /cpanel\.<your domain>/);
    return true;
  });
});

test("cPanel UAPI status 0 surfaces the first error, bounded", async () => {
  const { client } = cpanelFixture({
    "GET /execute/DomainInfo/list_domains": () => [
      200,
      { status: 0, errors: ["x".repeat(1000)], data: null },
    ],
  });
  await assert.rejects(client.validate(), (error) => {
    assert.equal(error.code, "provider_error");
    assert.ok(error.message.length < 400);
    return true;
  });
});

test("cPanel treats a body without a UAPI envelope as an unexpected response", async () => {
  for (const [body, type] of [
    [{ error: "not an envelope" }, "application/json"],
    [{ status: "1", data: {} }, "application/json"],
    [["status", 1], "application/json"],
    ["<html>Login</html>", "text/html"],
  ]) {
    const { client } = cpanelFixture({
      "GET /execute/DomainInfo/list_domains": () => [200, body, type],
    });
    await assert.rejects(client.validate(), (error) => {
      assert.equal(error.code, "provider_error");
      assert.ok(!error.message.includes(TOKEN));
      if (type === "application/json")
        assert.match(
          error.message,
          /unexpected response; check the panel address/,
        );
      return true;
    });
  }
});

test("an address that does not answer as a cPanel panel says so", async () => {
  const message =
    "This address did not answer as a cPanel panel. Check the cPanel address (for example https://server.example.com:2083).";
  for (const [status, body, type] of [
    [404, "Not Found", "text/html"],
    [200, "<html>Welcome</html>", "text/html"],
    [200, "not json", "application/json"],
  ]) {
    const { client } = cpanelFixture({
      "GET /execute/DomainInfo/list_domains": () => [status, body, type],
    });
    await assert.rejects(
      client.validate(),
      { code: "provider_error", message },
      `${status} ${body}`,
    );
  }
});

test("without WP Toolkit cPanel lists only domains whose root holds WordPress, once each", async () => {
  const { client } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    ...fileman({
      public_html: ["wp-config.php", "index.php"],
      plain: ["index.html"],
    }),
  });
  const sites = await client.listSites({ includeEnvironments: true });
  assert.deepEqual(sites, [
    {
      id: "wp.example.test",
      name: "wp.example.test",
      displayName: "wp.example.test",
      status: "unknown",
      primaryDomain: "wp.example.test",
      environments: [
        {
          id: "domain:wp.example.test",
          name: "live",
          displayName: "Live",
          isBlocked: false,
          isPremium: false,
          wordpressVersion: "7.1.3",
          primaryDomain: "https://wp.example.test/",
        },
      ],
    },
  ]);
});

test("with WP Toolkit cPanel uses its installations and ignores subfolder installs", async () => {
  const { client, calls } = cpanelFixture({
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    "GET /3rdparty/wpt/index.php/v1/installations": () => [
      200,
      [
        {
          id: 1,
          url: WP_HOME_URL,
          version: "7.1.3",
          path: "/home/wptest/public_html",
          status: { alive: true, multisite: false },
        },
        {
          id: 2,
          url: "https://wp.example.test/blog",
          version: "7.1.3",
          path: "/home/wptest/public_html/blog",
          status: { alive: true, multisite: false },
        },
      ],
    ],
  });
  const [site] = await client.listSites({ includeEnvironments: true });
  assert.equal(site.id, "wp.example.test");
  assert.equal(site.environments.length, 1);
  assert.equal(site.environments[0].wordpressVersion, "7.1.3");
  assert.equal((await client.listSites()).length, 1);
  const toolkit = calls.find((call) =>
    call.url.pathname.startsWith("/3rdparty/wpt/"),
  );
  assert.equal(toolkit.authorization, `cpanel ${USER}:${TOKEN}`);
  assert.equal(toolkit.url.origin, BASE);
});

test("cPanel getSite and listEnvironments resolve by domain and reject other ids", async () => {
  const { client } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    ...fileman({ public_html: ["wp-config.php"] }),
  });
  assert.equal((await client.getSite("wp.example.test")).id, "wp.example.test");
  assert.equal(
    (await client.listEnvironments("wp.example.test"))[0].id,
    "domain:wp.example.test",
  );
  await assert.rejects(client.getSite("plain.example.test"), {
    code: "not_found",
  });
  await assert.rejects(client.getSite("../x"), { code: "usage_error" });
});

test("a WordPress whose version.php cannot be read is listed without a version", async () => {
  const { client } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    "GET /execute/Fileman/list_files": () =>
      ok([{ file: "wp-config.php", type: "file" }]),
    "GET /execute/Fileman/get_file_content": () => [
      200,
      { status: 0, errors: ["Permission denied"], data: null },
    ],
  });
  const [site] = await client.listSites({ includeEnvironments: true });
  assert.equal(site.environments[0].wordpressVersion, undefined);
});

test("a malformed WP Toolkit installation list is a provider error, not an empty inventory", async () => {
  for (const body of [
    { not: "an array" },
    [
      {
        id: 1,
        url: WP_HOME_URL,
        version: "7",
        status: { alive: true, multisite: false },
      },
    ],
    [{ id: "1", url: WP_HOME_URL, version: "7", status: {} }],
    [{ id: 1, url: WP_HOME_URL, version: "7", status: { alive: true } }],
    [
      {
        id: 0,
        url: WP_HOME_URL,
        version: "7",
        status: { alive: true, multisite: false },
      },
    ],
  ]) {
    const { client } = cpanelFixture({
      "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
      "GET /3rdparty/wpt/index.php/v1/installations": () => [200, body],
    });
    await assert.rejects(client.listSites(), {
      code: "provider_error",
      message: "WP Toolkit returned an invalid installation list.",
    });
  }
});

const LOGIN_PAGE =
  '<!DOCTYPE html><html><head><title>cPanel Login</title></head><body><form action="/login/">Log in</form></body></html>';

test("WP Toolkit unavailable to the account (401 login page, 403 or 404) falls back to the file scan", async () => {
  for (const [status, body, type] of [
    [401, LOGIN_PAGE, "text/html"],
    [401, "Unauthorized", "text/plain"],
    [403, "Forbidden", "text/html"],
    [404, "Not Found", "text/html"],
  ]) {
    const { client, calls } = cpanelFixture({
      "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
      "GET /3rdparty/wpt/index.php/v1/installations": () => [
        status,
        body,
        type,
      ],
      ...fileman({ public_html: ["wp-config.php"], plain: ["index.html"] }),
    });
    const sites = await client.listSites();
    assert.deepEqual(
      sites.map((site) => site.id),
      ["wp.example.test"],
      String(status),
    );
    // UAPI answered first with the same token; WP Toolkit was asked once.
    assert.ok(
      calls.findIndex((call) => call.url.pathname.includes("domains_data")) <
        calls.findIndex((call) => call.url.pathname.includes("/3rdparty/")),
      String(status),
    );
    assert.equal(
      calls.filter((call) => call.url.pathname.includes("/3rdparty/")).length,
      1,
      String(status),
    );
  }
});

test("a bad token still fails as credential_invalid on the UAPI call that runs before WP Toolkit detection", async () => {
  for (const status of [401, 403]) {
    const { client, calls } = cpanelFixture({
      "GET /execute/DomainInfo/domains_data": () => [
        status,
        LOGIN_PAGE,
        "text/html",
      ],
      "GET /3rdparty/wpt/index.php/v1/installations": () => [
        status,
        LOGIN_PAGE,
        "text/html",
      ],
    });
    await assert.rejects(client.listSites(), { code: "credential_invalid" });
    assert.ok(
      calls.every((call) => !call.url.pathname.includes("/3rdparty/")),
      String(status),
    );
  }
});

test("a WP Toolkit detection failure other than 401, 403 or 404 is still an error", async () => {
  for (const [status, code] of [
    [500, "provider_error"],
    [429, "rate_limited"],
  ]) {
    const { client } = cpanelFixture({
      "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
      "GET /3rdparty/wpt/index.php/v1/installations": () => [
        status,
        "no",
        "text/plain",
      ],
      ...fileman({ public_html: ["wp-config.php"] }),
    });
    await assert.rejects(client.listSites(), { code }, String(status));
  }
});

const toolkitInstall = (overrides = {}) => ({
  id: 1,
  url: WP_HOME_URL,
  version: "7.1.3",
  path: "/home/wptest/public_html",
  status: { alive: true, multisite: false },
  ...overrides,
});

function toolkitFixture(installations, domains = DOMAINS_DATA) {
  return cpanelFixture({
    "GET /execute/DomainInfo/domains_data": () => ok(domains),
    "GET /3rdparty/wpt/index.php/v1/installations": () => [200, installations],
  });
}

test("with WP Toolkit the site URL is the installation's own origin, scheme and port included", async () => {
  for (const [url, expected] of [
    ["http://wp.example.test", "http://wp.example.test/"],
    ["https://wp.example.test:8443", "https://wp.example.test:8443/"],
    ["https://wp.example.test/", "https://wp.example.test/"],
  ]) {
    const { client } = toolkitFixture([toolkitInstall({ url })]);
    const sites = await client.listSites({ includeEnvironments: true });
    assert.equal(sites.length, 1);
    assert.equal(sites[0].id, "wp.example.test");
    assert.equal(sites[0].primaryDomain, "wp.example.test");
    assert.equal(sites[0].environments[0].primaryDomain, expected);
  }
});

test("with WP Toolkit a www. installation URL lists under the bare domain and keeps its www. URL", async () => {
  const { client } = toolkitFixture([
    toolkitInstall({ url: "https://www.wp.example.test" }),
  ]);
  const sites = await client.listSites({ includeEnvironments: true });
  assert.equal(sites.length, 1);
  assert.equal(sites[0].id, "wp.example.test");
  assert.equal(sites[0].environments[0].id, "domain:wp.example.test");
  assert.equal(
    sites[0].environments[0].primaryDomain,
    "https://www.wp.example.test/",
  );
});

test("with WP Toolkit an installation on an unknown host matches the domain by its path", async () => {
  const { client } = toolkitFixture([
    toolkitInstall({ id: 1, url: "https://elsewhere.example.test" }),
    toolkitInstall({
      id: 2,
      url: "https://lost.example.test",
      path: "/home/wptest/nowhere",
    }),
  ]);
  const sites = await client.listSites({ includeEnvironments: true });
  assert.deepEqual(
    sites.map((site) => [site.id, site.environments[0].primaryDomain]),
    [["wp.example.test", "https://elsewhere.example.test/"]],
  );
});

test("with WP Toolkit a host match beats a path match for the same domain, whatever the order", async () => {
  const byPath = toolkitInstall({
    id: 1,
    url: "https://elsewhere.example.test",
  });
  const byHost = toolkitInstall({ id: 2, url: "https://www.wp.example.test" });
  for (const installs of [
    [byPath, byHost],
    [byHost, byPath],
  ]) {
    const { client } = toolkitFixture(installs);
    const sites = await client.listSites({ includeEnvironments: true });
    assert.deepEqual(
      sites.map((site) => [site.id, site.environments[0].primaryDomain]),
      [["wp.example.test", "https://www.wp.example.test/"]],
    );
  }
});

test("with WP Toolkit an installation URL that is not http or https is ignored", async () => {
  const { client } = toolkitFixture([
    toolkitInstall({ url: "ftp://wp.example.test" }),
  ]);
  assert.deepEqual(await client.listSites(), []);
});

test("with WP Toolkit an installation that is not alive is listed and its environment is blocked", async () => {
  const { client } = toolkitFixture([
    toolkitInstall({ status: { alive: false, multisite: false } }),
  ]);
  const [site] = await client.listSites({ includeEnvironments: true });
  assert.equal(site.environments[0].isBlocked, true);
  const live = toolkitFixture([toolkitInstall()]);
  const [alive] = await live.client.listSites({ includeEnvironments: true });
  assert.equal(alive.environments[0].isBlocked, false);
});

test("without WP Toolkit a WordPress environment is not blocked", async () => {
  const { client } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    ...fileman({ public_html: ["wp-config.php"] }),
  });
  const [site] = await client.listSites({ includeEnvironments: true });
  assert.equal(site.environments[0].isBlocked, false);
});

test("a domain entry cPanel describes with an unusable name or document root is skipped, not fatal", async () => {
  const entry = (domain, documentroot) => ({
    domain,
    documentroot,
    homedir: "/home/wptest",
    type: "addon_domain",
    user: "wptest",
  });
  // Every directory a naive reading of these roots would list holds a
  // wp-config.php, so accepting any of them would add a site or a request.
  const trap = {
    plain: ["wp-config.php"],
    wild: ["wp-config.php"],
    public_html: ["wp-config.php"],
    other: ["wp-config.php"],
    "": ["wp-config.php"],
    ".": ["wp-config.php"],
    "..": ["wp-config.php"],
    "public_html/..": ["wp-config.php"],
    "public_html/.": ["wp-config.php"],
    "./public_html": ["wp-config.php"],
    "../other/public_html": ["wp-config.php"],
  };
  for (const documentroot of [
    "/home/wptest/../other/public_html",
    "/home/wptest/public_html/..",
    "/home/wptest/./public_html",
    "/home/wptest/public_html/.",
    "/home/wptest",
    "/home/wptest/",
    "/elsewhere/public_html",
  ]) {
    const { client, calls } = cpanelFixture({
      ...NO_TOOLKIT,
      "GET /execute/DomainInfo/domains_data": () =>
        ok({
          main_domain: entry("wp.example.test", documentroot),
          addon_domains: [entry("plain.example.test", "/home/wptest/plain")],
          sub_domains: [entry("*.example.test", "/home/wptest/wild")],
          parked_domains: [],
        }),
      ...fileman(trap),
    });
    assert.deepEqual(
      (await client.listSites()).map((site) => site.id),
      ["plain.example.test"],
      documentroot,
    );
    const dirs = calls
      .filter((call) => call.url.pathname === "/execute/Fileman/list_files")
      .map((call) => call.url.searchParams.get("dir"));
    assert.deepEqual(dirs, ["plain"], documentroot);
    assert.ok(
      dirs.every(
        (dir) => !dir.split("/").some((part) => part === "." || part === ".."),
      ),
      documentroot,
    );
  }
});

test("a malformed domain name from cPanel is skipped and never becomes a usage error", async () => {
  const { client } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () =>
      ok({
        main_domain: { ...DOMAINS_DATA.main_domain, domain: "not a domain" },
        addon_domains: DOMAINS_DATA.addon_domains,
        sub_domains: [],
      }),
    ...fileman({ public_html: ["wp-config.php"] }),
  });
  assert.deepEqual(
    (await client.listSites()).map((site) => site.id),
    ["alias.example.test"],
  );
});

test("a document root cPanel cannot list is skipped while the other domains still list", async () => {
  const { client } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    "GET /execute/Fileman/list_files": (url) =>
      url.searchParams.get("dir") === "public_html"
        ? [200, { status: 0, errors: ["Permission denied"], data: null }]
        : ok([{ file: "wp-config.php", type: "file" }]),
    "GET /execute/Fileman/get_file_content": () => [
      200,
      { status: 0, errors: ["no"], data: null },
    ],
  });
  assert.deepEqual(
    (await client.listSites()).map((site) => site.id),
    ["plain.example.test"],
  );
});

test("a listing failure that is not a provider error stays fatal", async () => {
  for (const [status, code] of [
    [401, "credential_invalid"],
    [429, "rate_limited"],
  ]) {
    const { client } = cpanelFixture({
      ...NO_TOOLKIT,
      "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
      "GET /execute/Fileman/list_files": () => [status, "no", "text/plain"],
    });
    await assert.rejects(client.listSites(), { code });
  }
  const stub = (listFiles) => ({
    username: USER,
    origin: BASE,
    toolkitInstallations: async () => undefined,
    wpt: async () => undefined,
    uapi: async (module, fn) => {
      if (fn === "domains_data") return DOMAINS_DATA;
      if (fn === "list_files") return listFiles();
      throw new Error(`unexpected ${module}::${fn}`);
    },
  });
  for (const code of ["timeout", "credential_invalid", "network_error"])
    await assert.rejects(
      discoverWordPress(
        stub(() => {
          throw new CliError(code, "stop");
        }),
      ),
      { code },
    );
});

const BACKUP_FILE = "backup-10.9.2026_13-52-15_wptest.tar.gz";

test("cPanel lists only this account's home-directory backups", async () => {
  const { client } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    "GET /execute/Fileman/list_files": (url) =>
      url.searchParams.get("dir") === "" || url.searchParams.get("dir") === null
        ? ok([
            {
              file: BACKUP_FILE,
              type: "file",
              size: "37055357",
              mtime: 1791553935,
            },
            {
              file: "backup-10.9.2026_13-52-15_other.tar.gz",
              type: "file",
              size: "1",
              mtime: 1,
            },
            { file: "notes.txt", type: "file", size: "3", mtime: 1 },
          ])
        : ok([{ file: "wp-config.php", type: "file" }]),
    "GET /execute/Fileman/get_file_content": () => ok({ content: VERSION_PHP }),
  });
  assert.deepEqual(
    await client.read({ kind: "backups", envId: "domain:wp.example.test" }),
    {
      backups: [
        {
          id: BACKUP_FILE,
          filename: BACKUP_FILE,
          size_bytes: 37055357,
          created_at: "2026-10-09T13:52:15Z",
        },
      ],
    },
  );
});

test("cPanel backups are listed newest first and unusable names or sizes are skipped", async () => {
  const names = [
    ["backup-9.30.2026_01-02-03_wptest.tar.gz", "5"],
    ["backup-10.9.2026_13-52-15_wptest.tar.gz", "7"],
    ["backup-13.9.2026_13-52-15_wptest.tar.gz", "9"],
    ["backup-10.9.2026_13-52-16_wptest.tar.gz", "not-a-size"],
    ["backup-10.9.2026_13-52-17_wptest.tar.gz.part", "9"],
  ];
  const { client } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    "GET /execute/Fileman/list_files": (url) =>
      url.searchParams.get("dir") === ""
        ? ok(names.map(([file, size]) => ({ file, type: "file", size })))
        : ok([{ file: "wp-config.php", type: "file" }]),
    "GET /execute/Fileman/get_file_content": () => ok({ content: VERSION_PHP }),
  });
  const { backups } = await client.read({
    kind: "backups",
    envId: "domain:wp.example.test",
  });
  assert.deepEqual(
    backups.map((backup) => [backup.created_at, backup.size_bytes]),
    [
      ["2026-10-09T13:52:15Z", 7],
      ["2026-09-30T01:02:03Z", 5],
    ],
  );
});

test("cPanel backups and logs reject an environment that is not a WordPress domain here", async () => {
  const { client, calls } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    ...fileman({ public_html: ["wp-config.php"] }),
  });
  for (const request of [
    { kind: "backups", envId: "domain:plain.example.test" },
    { kind: "backups", envId: "1" },
    {
      kind: "logs",
      envId: "domain:other.example.test",
      fileName: "error",
      lines: 5,
    },
  ])
    await assert.rejects(client.read(request), (error) =>
      ["not_found", "usage_error"].includes(error.code),
    );
  await assert.rejects(
    client.action({
      kind: "create-backup",
      envId: "domain:other.example.test",
    }),
    { code: "not_found" },
  );
  assert.ok(
    !calls.some(
      (call) =>
        call.url.pathname === "/execute/Backup/fullbackup_to_homedir" ||
        call.url.pathname === "/execute/Stats/get_site_errors",
    ),
  );
});

test("cPanel backup creation waits for a new, stable file", async () => {
  let listing = 0;
  const sleeps = [];
  const { client, calls } = cpanelFixture(
    {
      ...NO_TOOLKIT,
      "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
      "GET /execute/Fileman/get_file_content": () =>
        ok({ content: VERSION_PHP }),
      "POST /execute/Backup/fullbackup_to_homedir": () => ok({ pid: "83248" }),
      "GET /execute/Fileman/list_files": (url) => {
        if (url.searchParams.get("dir") !== "")
          return ok([{ file: "wp-config.php", type: "file" }]);
        listing++;
        const size = listing === 1 ? null : listing === 2 ? "10" : "20";
        return ok(
          size === null
            ? []
            : [{ file: BACKUP_FILE, type: "file", size, mtime: 1 }],
        );
      },
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  const result = await client.action({
    kind: "create-backup",
    envId: "domain:wp.example.test",
  });
  assert.equal(result.raw.backup_id, BACKUP_FILE);
  assert.equal(result.action, "backups.create");
  assert.deepEqual(sleeps, [10_000, 10_000, 10_000]);
  const paths = calls.map(
    (call) => `${call.url.pathname}?dir=${call.url.searchParams.get("dir")}`,
  );
  const started = paths.indexOf(
    "/execute/Backup/fullbackup_to_homedir?dir=null",
  );
  assert.ok(started > paths.indexOf("/execute/Fileman/list_files?dir="));
  assert.equal(
    paths.filter((path) => path.includes("fullbackup_to_homedir")).length,
    1,
  );
  assert.equal(
    calls.find((call) => call.url.pathname.endsWith("fullbackup_to_homedir"))
      .method,
    "POST",
  );
  const status = await client.operationStatus(result.operationId);
  assert.equal(status.done, true);
  assert.equal(status.failed, false);
  assert.equal(status.status, 200);
  await assert.rejects(client.operationStatus("unknown"), {
    code: "provider_unsupported",
  });
});

test("cPanel backup creation reports a start that cPanel refuses without waiting", async () => {
  const sleeps = [];
  const { client } = cpanelFixture(
    {
      ...NO_TOOLKIT,
      "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
      "GET /execute/Fileman/get_file_content": () =>
        ok({ content: VERSION_PHP }),
      "GET /execute/Fileman/list_files": (url) =>
        ok(
          url.searchParams.get("dir") === ""
            ? []
            : [{ file: "wp-config.php", type: "file" }],
        ),
      "POST /execute/Backup/fullbackup_to_homedir": () => [
        200,
        { status: 0, errors: ["The disk quota is exceeded."], data: null },
      ],
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  await assert.rejects(
    client.action({ kind: "create-backup", envId: "domain:wp.example.test" }),
    { code: "provider_error", message: /disk quota is exceeded/ },
  );
  assert.deepEqual(sleeps, []);
});

test("a failed backup start is never repeated, even when the client retries other requests", async () => {
  const unavailable = () => [503, "Service Unavailable", "text/plain"];
  const { client, calls } = cpanelFixture(
    {
      ...NO_TOOLKIT,
      "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
      "GET /execute/Fileman/get_file_content": () =>
        ok({ content: VERSION_PHP }),
      "GET /execute/Fileman/list_files": (url) =>
        ok(
          url.searchParams.get("dir") === ""
            ? []
            : [{ file: "wp-config.php", type: "file" }],
        ),
      // Whatever the method, the start answers 503: a replay would show here.
      "POST /execute/Backup/fullbackup_to_homedir": unavailable,
      "GET /execute/Backup/fullbackup_to_homedir": unavailable,
    },
    { retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 } },
  );
  await assert.rejects(
    client.action({ kind: "create-backup", envId: "domain:wp.example.test" }),
  );
  const starts = calls.filter((call) =>
    call.url.pathname.endsWith("/Backup/fullbackup_to_homedir"),
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].method, "POST");
});

/** A sleep that only ends when the signal aborts, like the real timer. */
function abortableSleep(entered) {
  return (ms, signal) =>
    new Promise((resolve, reject) => {
      entered?.(ms);
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
}

function backupRoutes(extra = {}) {
  return {
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    "GET /execute/Fileman/get_file_content": () => ok({ content: VERSION_PHP }),
    "GET /execute/Fileman/list_files": (url) =>
      ok(
        url.searchParams.get("dir") === ""
          ? []
          : [{ file: "wp-config.php", type: "file" }],
      ),
    "POST /execute/Backup/fullbackup_to_homedir": () => ok({ pid: "1" }),
    ...extra,
  };
}

const homeListings = (calls) =>
  calls.filter(
    (call) =>
      call.url.pathname === "/execute/Fileman/list_files" &&
      call.url.searchParams.get("dir") === "",
  ).length;

test("cPanel backup creation with wait: false starts the backup once and returns at once", async () => {
  const sleeps = [];
  const { client, calls } = cpanelFixture(backupRoutes(), {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const result = await client.action({
    kind: "create-backup",
    envId: "domain:wp.example.test",
    wait: false,
  });
  const note =
    "cPanel is creating the account backup in the background. It can take several minutes; check hosting_backups_list for the new file.";
  assert.deepEqual(result, {
    provider: "cpanel",
    action: "backups.create",
    status: 202,
    message: note,
    raw: { started: true, note },
  });
  assert.deepEqual(sleeps, []);
  assert.equal(
    calls.filter((call) =>
      call.url.pathname.endsWith("/Backup/fullbackup_to_homedir"),
    ).length,
    1,
  );
  assert.equal(homeListings(calls), 0);
});

test("aborting during the backup poll ends the action promptly with no further requests", async () => {
  const controller = new AbortController();
  let entered;
  const sleeping = new Promise((resolve) => {
    entered = resolve;
  });
  const { client, calls } = cpanelFixture(backupRoutes(), {
    sleep: abortableSleep(entered),
  });
  const running = client.action({
    kind: "create-backup",
    envId: "domain:wp.example.test",
    signal: controller.signal,
  });
  const outcome = running.then(
    () => "resolved",
    (error) => error,
  );
  // A failure before the first sleep settles `outcome` and fails below.
  await Promise.race([sleeping, outcome]);
  const listed = homeListings(calls);
  const total = calls.length;
  assert.equal(listed, 1);
  controller.abort();
  const error = await Promise.race([
    outcome,
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1000)),
  ]);
  assert.equal(error?.name, "AbortError");
  assert.equal(homeListings(calls), listed);
  assert.equal(calls.length, total);
});

test("a sleep that ignores the signal still cannot lead to another list call after abort", async () => {
  const controller = new AbortController();
  const { client, calls } = cpanelFixture(backupRoutes(), {
    sleep: async () => controller.abort(),
  });
  await assert.rejects(
    client.action({
      kind: "create-backup",
      envId: "domain:wp.example.test",
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(homeListings(calls), 1);
});

test("an already aborted backup request makes no request at all", async () => {
  const { client, calls } = cpanelFixture(backupRoutes());
  await assert.rejects(
    client.action({
      kind: "create-backup",
      envId: "domain:wp.example.test",
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, []);
});

function homeApi(listings) {
  let index = 0;
  return {
    username: USER,
    origin: BASE,
    toolkitInstallations: async () => undefined,
    wpt: async () => undefined,
    uapi: async (module, fn) => {
      assert.equal(`${module}::${fn}`, "Fileman::list_files");
      const rows = listings[Math.min(index, listings.length - 1)];
      index++;
      return rows.map(([file, size]) => ({ file, type: "file", size }));
    },
  };
}

test("waiting for an account backup ignores older files, needs two equal sizes and gives up at the deadline", async () => {
  const older = "backup-1.2.2026_03-04-05_wptest.tar.gz";
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
  };
  // A new file that keeps growing never finishes within the deadline.
  let size = 0;
  const growing = {
    ...homeApi([[]]),
    uapi: async () => [
      { file: older, type: "file", size: "99" },
      { file: BACKUP_FILE, type: "file", size: String(++size * 10) },
    ],
  };
  await assert.rejects(
    waitForNewBackup(growing, new Set([older]), { sleep, deadlineMs: 30_000 }),
    (error) => {
      assert.equal(error.code, "timeout");
      assert.match(error.message, /may still complete/);
      return true;
    },
  );
  assert.deepEqual(sleeps, [10_000, 10_000, 10_000]);
  // An empty new file is not a finished backup, even when its size repeats.
  await assert.rejects(
    waitForNewBackup(homeApi([[[BACKUP_FILE, "0"]]]), new Set(), {
      sleep,
      deadlineMs: 40_000,
    }),
    { code: "timeout" },
  );
  // The older file alone never counts.
  await assert.rejects(
    waitForNewBackup(homeApi([[[older, "5"]]]), new Set([older]), {
      sleep,
      deadlineMs: 30_000,
    }),
    { code: "timeout" },
  );
  // A file that disappears between polls restarts the stability check.
  assert.equal(
    await waitForNewBackup(
      homeApi([
        [[BACKUP_FILE, "7"]],
        [],
        [[BACKUP_FILE, "7"]],
        [[BACKUP_FILE, "7"]],
      ]),
      new Set(),
      { sleep, deadlineMs: 600_000 },
    ),
    BACKUP_FILE,
  );
});

test("cPanel reads the domain error log through Stats::get_site_errors", async () => {
  const { client, calls } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    ...fileman({ public_html: ["wp-config.php"] }),
    "GET /execute/Stats/get_site_errors": () =>
      ok([{ date: 1791553163.1, entry: "[core:crit] AH00529 example" }]),
  });
  const logs = await client.read({
    kind: "logs",
    envId: "domain:wp.example.test",
    fileName: "error",
    lines: 50,
  });
  assert.deepEqual(logs, { lines: ["[core:crit] AH00529 example"] });
  const call = calls.find(
    (c) => c.url.pathname === "/execute/Stats/get_site_errors",
  );
  assert.equal(call.url.searchParams.get("domain"), "wp.example.test");
  assert.equal(call.url.searchParams.get("log"), "error");
  assert.equal(call.url.searchParams.get("maxlines"), "50");
});

test("cPanel error logs bound the line count, accept an empty log and refuse other logs", async () => {
  let data = [];
  const { client, calls } = cpanelFixture({
    ...NO_TOOLKIT,
    "GET /execute/DomainInfo/domains_data": () => ok(DOMAINS_DATA),
    ...fileman({ public_html: ["wp-config.php"] }),
    "GET /execute/Stats/get_site_errors": () => ok(data),
  });
  const read = (lines, fileName = "error") =>
    client.read({
      kind: "logs",
      envId: "domain:wp.example.test",
      fileName,
      lines,
    });
  assert.deepEqual(await read(0), { lines: [] });
  data = null;
  assert.deepEqual(await read(10), { lines: [] });
  data = [{ date: 1, entry: "kept" }, { date: 2 }, { entry: 3 }];
  assert.deepEqual(await read(10), { lines: ["kept"] });
  await read(1_000_000);
  await read(10.7);
  const requested = calls
    .filter((call) => call.url.pathname === "/execute/Stats/get_site_errors")
    .map((call) => call.url.searchParams.get("maxlines"));
  assert.deepEqual(requested, ["100", "10", "10", "5000", "10"]);
  data = { entry: "not a list" };
  await assert.rejects(read(10), { code: "provider_error" });
  const before = calls.length;
  await assert.rejects(read(10, "access"), { code: "provider_unsupported" });
  assert.equal(calls.length, before);
});

test("cPanel advertises backups and logs and declares the rest unsupported", async () => {
  const { client } = cpanelFixture();
  const capabilities = await client.read({ kind: "capabilities" });
  const byName = new Map(capabilities.map((entry) => [entry.name, entry]));
  for (const name of ["backups.list", "backups.create", "logs.get"])
    assert.equal(byName.get(name)?.supported, true, name);
  for (const name of [
    "backups.restore",
    "cache.clear",
    "php.restart",
    "php.set-version",
    "wp-cli.run",
    "wp.plugins.install",
    "wp.plugins.update",
    "domains.add",
    "domains.primary",
  ])
    assert.equal(byName.get(name)?.supported, false, name);
  assert.equal(
    byName.get("backups.restore").notes,
    "cPanel has no user-level restore API",
  );
  assert.equal(
    byName.get("cache.clear").notes,
    "Not available through the cPanel user API",
  );
  assert.match(byName.get("backups.create").notes, /disk quota/);
});

test("the dashboard backup page names the cPanel account backup and its disk-quota cost", () => {
  const target = {
    profile: "account",
    site: "wp.example.test",
    env: "domain:wp.example.test",
  };
  const review = {
    ...target,
    id: "review",
    operation: "create",
    provider: "cpanel",
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
  const other = renderHtml(
    renderBackupCreate({
      create: true,
      target,
      job: { review: { ...review, provider: "kinsta" }, status: "completed" },
    }),
  );
  assert.match(other, /href="\/backup-restore\?[^"]*"[^>]*>View backups</);
  assert.match(
    renderHtml(
      renderBackupCreate({
        create: true,
        target,
        review: { ...review, provider: "kinsta" },
      }),
    ),
    />Create backup<\/button>/,
  );
  assert.match(
    renderHtml(
      renderBackupCreate({
        create: true,
        target,
        review: { ...review, provider: "kinsta" },
      }),
    ),
    /Backup label: Novamira HQ/,
  );
});
