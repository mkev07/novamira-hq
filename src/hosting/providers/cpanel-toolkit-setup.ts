// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Novamira setup through the account's WP Toolkit. */

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import { compareSemverStrings, isSemver } from "../../semver.js";
import type { ActionRequest } from "../client.js";
import { downloadNovamiraArchive } from "../novamira-archive.js";
import type { ActionResult } from "../types.js";
import type { CpanelWordPress } from "./cpanel-sites.js";
import type { CpanelApi } from "./cpanel-uapi.js";

type SetupRequest = Extract<ActionRequest, { kind: "setup-novamira" }>;
/** The manual path every refusal points to. */
export const MANUAL_SETUP =
  "Install Novamira from WordPress → Plugins, then connect the site by URL.";
const MINIMUM_VERSION = "1.11.1";
const PLUGIN_LIST = ["plugin", "list", "--name=novamira", "--format=json"];
const REFRESH_CODE = "clear-installation-cache";
const POLL_MS = 2000;
/** Polls after the first answer; 30 x 2 s is about a minute. */
const REFRESH_POLLS = 30;

interface Plugin {
  readonly version: string;
  readonly status: "active" | "inactive";
}

function invalidPluginList(): CliError {
  return new CliError(
    "provider_error",
    `WP Toolkit returned an invalid plugin list. ${MANUAL_SETUP}`,
  );
}

/** The rows `wp plugin list --name=novamira --format=json` printed. */
async function toolkitPluginRows(
  api: CpanelApi,
  installationId: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  let rows: unknown;
  try {
    rows = JSON.parse(await api.wpCli(installationId, PLUGIN_LIST, signal));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw invalidPluginList();
  }
  if (!Array.isArray(rows)) throw invalidPluginList();
  return rows.map((row) => {
    const record = asRecord(row);
    if (record === undefined) throw invalidPluginList();
    return record;
  });
}

function novamira(
  rows: readonly Record<string, unknown>[],
): Plugin | undefined {
  const matches = rows.filter((row) => row.name === "novamira");
  if (matches.length === 0) return undefined;
  const found = matches[0];
  if (
    matches.length !== 1 ||
    typeof found?.version !== "string" ||
    !isSemver(found.version) ||
    (found.status !== "active" && found.status !== "inactive")
  )
    throw new CliError(
      "provider_error",
      "Novamira's state on this site is ambiguous. Check Plugins in WordPress.",
    );
  return { version: found.version, status: found.status };
}

/**
 * WP Toolkit keeps its own copy of each site's plugin list. When Novamira was
 * removed outside WP Toolkit, that copy still names it and the asset install
 * fails on `plugin status novamira`. Its public cache cleaner brings the copy
 * up to date; setup waits for that task before it reads or uploads anything.
 * The task is polled at the path built from its code and id, whatever URL the
 * answer carries, so nothing outside the cPanel panel is ever requested.
 */
async function refreshToolkitCache(
  api: CpanelApi,
  installationId: number,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const failed = () =>
    new CliError(
      "provider_error",
      "WP Toolkit could not refresh this site's details. Check WP Toolkit in cPanel before retrying.",
    );
  let answer: unknown;
  try {
    answer = await api.wpt("/v1/cache-cleaner", {
      method: "POST",
      json: { installationsIds: [installationId] },
      signal,
    });
  } catch (error) {
    // Older WP Toolkit releases have no cache cleaner; their plugin list is
    // read as it is.
    if (error instanceof CliError && error.details?.status === 404) return;
    throw error;
  }
  const accepted = asRecord(answer);
  const task = asRecord(accepted?.task);
  const taskId = task?.id;
  if (
    task?.code !== REFRESH_CODE ||
    typeof taskId !== "number" ||
    !Number.isSafeInteger(taskId) ||
    taskId <= 0
  )
    throw failed();
  for (let attempt = 0; ; attempt++) {
    const current = asRecord(
      await api.wpt(`/v1/background-tasks/${REFRESH_CODE}/${String(taskId)}`, {
        signal,
      }),
    );
    if (current?.status === "done") return;
    if (
      current?.status === "error" ||
      current?.status === "canceled" ||
      attempt >= REFRESH_POLLS
    )
      throw failed();
    await sleep(POLL_MS, signal);
  }
}

/**
 * `siteUrl` is the installation's real origin. Setup supports WordPress at
 * the HTTPS root of the cPanel domain or of its `www.` name, on the default
 * port; the AI Abilities domain and the installer's host check use the
 * address's own host name.
 */
export function rootHttpsUrl(site: CpanelWordPress): URL {
  let url: URL;
  try {
    url = new URL(site.siteUrl);
  } catch {
    throw new CliError(
      "provider_error",
      "cPanel did not provide a valid site URL.",
    );
  }
  const refuse = (reason: string): CliError =>
    new CliError("provider_unsupported", `${reason} ${MANUAL_SETUP}`);
  if (url.protocol !== "https:")
    throw new CliError(
      "provider_unsupported",
      "This site's WordPress address does not use HTTPS. Turn on HTTPS for the site, or install Novamira from WordPress → Plugins, then connect the site by URL.",
    );
  if (url.port !== "")
    throw refuse(
      `This site's WordPress address uses port ${url.port}; cPanel setup supports only the default HTTPS port.`,
    );
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw refuse(
      "This site's WordPress address is not the root of its domain; cPanel setup supports only WordPress installed at the domain root.",
    );
  if (url.hostname !== site.domain && url.hostname !== `www.${site.domain}`)
    throw refuse(
      `This site's WordPress address is ${url.hostname}, which is not this cPanel domain (${site.domain}).`,
    );
  return url;
}

/** WordPress 6.9 or newer; `6.9`, `6.9.1` and `7.0-beta1` read as expected. */
export function wordpressSupported(version: string): boolean {
  const core = version.split("-", 1)[0] ?? "";
  const wordpress = /^\d+\.\d+$/.test(core) ? `${core}.0` : core;
  return isSemver(wordpress) && compareSemverStrings(wordpress, "6.9.0") >= 0;
}

export async function setupWithToolkit(
  api: CpanelApi,
  fetcher: typeof fetch,
  site: CpanelWordPress,
  request: SetupRequest,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<ActionResult> {
  const id = site.toolkitId;
  if (id === undefined)
    throw new CliError(
      "internal_error",
      "WP Toolkit installation id is missing.",
    );
  const url = rootHttpsUrl(site);
  if (site.alive === false)
    throw new CliError(
      "server_unsupported",
      "The WP Toolkit installation is not working.",
    );
  if (site.multisite)
    throw new CliError(
      "server_unsupported",
      "Novamira setup does not support WordPress multisite.",
    );
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(300_000)])
    : AbortSignal.timeout(300_000);
  const wp = (argv: readonly string[]) => api.wpCli(id, argv, signal);
  if (!wordpressSupported(site.version ?? ""))
    throw new CliError(
      "server_unsupported",
      "Novamira setup requires WordPress 6.9 or newer.",
    );
  const php = (await wp(["eval", "echo PHP_VERSION;"])).trim();
  if (!isSemver(php) || compareSemverStrings(php, "8.0.0") < 0)
    throw new CliError(
      "server_unsupported",
      "Novamira setup requires PHP 8.0 or newer.",
    );
  await refreshToolkitCache(api, id, sleep, signal);
  const inspect = async () =>
    novamira(await toolkitPluginRows(api, id, signal));
  let existing = await inspect();
  if (existing && compareSemverStrings(existing.version, MINIMUM_VERSION) < 0)
    throw new CliError(
      "server_unsupported",
      "Update the existing Novamira installation before setup; it will not be overwritten.",
    );
  const previouslyInstalled = existing !== undefined;
  if (!existing) {
    const archive = await downloadNovamiraArchive(fetcher, signal, "cPanel");
    signal.throwIfAborted();
    const accepted = asRecord(
      await api.wpt(
        `/v1/installations/${String(id)}/features/uploader/plugins`,
        {
          method: "POST",
          multipart: {
            kind: "multipart",
            fields: { status: "true" },
            files: [
              {
                field: "file",
                filename: "novamira.zip",
                contentType: "application/zip",
                bytes: archive,
              },
            ],
          },
          signal,
          timeoutMs: 120_000,
        },
      ),
    );
    const task = asRecord(accepted?.task);
    if (typeof task?.id !== "number" || task.code !== "install-custom-plugin")
      throw new CliError(
        "provider_error",
        "WP Toolkit did not accept the Novamira upload.",
      );
    for (let attempt = 0; ; attempt++) {
      const current = asRecord(
        await api.wpt(
          `/v1/background-tasks/install-custom-plugin/${String(task.id)}`,
          { signal },
        ),
      );
      if (current?.status === "done") break;
      if (
        current?.status === "error" ||
        current?.status === "canceled" ||
        attempt >= 60
      )
        throw new CliError(
          "provider_error",
          "WP Toolkit could not install Novamira. Check WP Toolkit in cPanel before retrying.",
        );
      await sleep(POLL_MS, signal);
    }
    existing = await inspect();
    if (
      !existing ||
      compareSemverStrings(existing.version, MINIMUM_VERSION) < 0
    )
      throw new CliError(
        "provider_error",
        "Novamira installation was not verified; check WordPress before retrying.",
      );
  }
  if (existing.status !== "active") {
    signal.throwIfAborted();
    await api.wpt(`/v1/installations/${String(id)}/plugins/novamira/status`, {
      method: "PUT",
      json: { status: true },
      signal,
    });
    existing = await inspect();
    if (existing?.status !== "active")
      throw new CliError(
        "provider_error",
        "Novamira activation was not verified; check WordPress before retrying.",
      );
  }
  const enableAi = request.enableAiAbilities ?? !previouslyInstalled;
  if (enableAi) {
    signal.throwIfAborted();
    await wp([
      "option",
      "update",
      "novamira_ai_abilities_domain",
      url.hostname,
    ]);
    await wp(["option", "update", "novamira_ai_abilities_enabled", "1"]);
    const domain = (
      await wp(["option", "get", "novamira_ai_abilities_domain"])
    ).trim();
    const enabled = (
      await wp(["option", "get", "novamira_ai_abilities_enabled"])
    ).trim();
    if (domain !== url.hostname || enabled !== "1")
      throw new CliError(
        "provider_error",
        "Novamira AI Abilities settings were not verified.",
      );
  }
  return {
    provider: "cpanel",
    action: "novamira.setup",
    status: 200,
    raw: {
      siteUrl: site.siteUrl,
      version: existing.version,
      aiEnabled: enableAi ? true : null,
      warnings: [],
    },
  };
}
