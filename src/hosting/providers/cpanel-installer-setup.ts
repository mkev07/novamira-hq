// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Novamira setup on cPanel accounts without WP Toolkit, through a
 * self-removing must-use installer the user has explicitly approved.
 *
 * Every path this module writes or deletes is built from one generated
 * `novamira-hq-setup-<uuid>` slug; nothing else on the site is ever removed.
 */

import { createHash } from "node:crypto";
import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import {
  MINIMUM_NOVAMIRA_VERSION,
  PROTECTED_RESOURCE_PATH,
  SITE_REQUEST_USER_AGENT,
} from "../../provisioning/compatibility.js";
import { compareSemverStrings, isSemver } from "../../semver.js";
import type { ActionRequest } from "../client.js";
import { downloadNovamiraArchive } from "../novamira-archive.js";
import type { ActionResult } from "../types.js";
import { cpanelInstaller } from "./cpanel-installer.js";
import {
  type CpanelWordPress,
  novamiraPluginRowsFromFiles,
} from "./cpanel-sites.js";
import { discardBody, readBoundedText } from "../../provisioning/http.js";
import { rootHttpsUrl, wordpressSupported } from "./cpanel-toolkit-setup.js";
import type { CpanelApi } from "./cpanel-uapi.js";

type SetupRequest = Extract<ActionRequest, { kind: "setup-novamira" }>;

export interface InstallerSetupDependencies {
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly uuid: () => string;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
}

const SLUG =
  /^novamira-hq-setup-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Seconds a generated leftover counts as belonging to a live run. */
const TEN_MINUTES = 600;
/**
 * Seconds the installer stays valid after cPanel wrote it, by the server's
 * own clock (the file's modification time); HQ waits about a minute.
 */
const INSTALLER_TTL = 180;
const POLL_MS = 2000;
/** 60 s of polling at 2 s; the trigger is repeated once at 30 s. */
const POLLS = 30;
const RETRIGGER_AT = 15;

/** Apache 2.4 and 2.2 forms; removed with the working directory. */
const DENY_ALL =
  "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n";
const CONSENT_MESSAGE =
  "This cPanel account has no WP Toolkit. Novamira HQ can upload Novamira and a temporary installer that removes itself after one run. Ask the user to approve the temporary installer: in the dashboard tick the approval on the setup page; from the CLI add --temporary-installer; through MCP pass allowTemporaryInstaller only after the user approves. Or install Novamira from WordPress → Plugins.";
const NO_REPORT_MESSAGE =
  "The temporary installer did not report a result. It may have partly run; check Plugins in WordPress before retrying.";
const CONFLICT_MESSAGE =
  "Another Novamira setup is running on this site. Wait ten minutes, then try again.";
const PERMALINKS_MESSAGE =
  "WordPress permalinks are off on this site, so the temporary installer cannot run. Turn on permalinks in WordPress → Settings → Permalinks, or install Novamira from WordPress → Plugins.";

const INSTALLER_ERRORS: Readonly<Record<string, string>> = {
  expired: "The temporary installer expired before WordPress ran it.",
  host: "The site's WordPress address does not match this domain.",
  requirements: "This site needs WordPress 6.9 and PHP 8.0 or newer.",
  multisite: "Novamira setup does not support WordPress multisite.",
  zip: "This site's PHP has no ZIP support; ask your host to enable the PHP zip extension, or install Novamira from WordPress → Plugins.",
  activation:
    "WordPress refused to activate Novamira; check Plugins in WordPress.",
  exists:
    "A Novamira folder appeared while setup was running; check Plugins in WordPress before retrying.",
  incomplete:
    "Novamira could not be installed completely; nothing was activated. Try again.",
  old: `Novamira on this site is older than ${MINIMUM_NOVAMIRA_VERSION}; nothing was activated. Update Novamira in WordPress → Plugins, then try again.`,
  missing:
    "Novamira was not found in the plugins folder; nothing was activated. Check Plugins in WordPress before retrying.",
  filesystem:
    "WordPress could not write files on this site; nothing was installed. Check the permissions of wp-content, or install Novamira from WordPress → Plugins.",
  extract:
    "WordPress could not unpack Novamira; nothing was installed. Try again, or install Novamira from WordPress → Plugins.",
  options:
    "Novamira is active, but its AI Abilities settings could not be saved. Turn on AI Abilities in Novamira's settings in WordPress.",
  exception:
    "The temporary installer stopped on an unexpected error. Check Plugins in WordPress before retrying.",
  destination:
    "WordPress could not move Novamira into the plugins folder; nothing was activated. Check Plugins in WordPress before retrying.",
  entry:
    "The Novamira package has no plugin file; nothing was installed. Try again.",
  unsafe:
    "The Novamira package contains unexpected paths; nothing was installed. Try again.",
  link: "The Novamira package contains a link; nothing was installed. Try again.",
  archive:
    "The Novamira package could not be opened on the site; nothing was installed. Try again.",
  digest:
    "The Novamira package on the site does not match the download; nothing was installed. Try again.",
};

/** cPanel's answer for a path that is not there (verified on cPanel 138). */
function missing(error: unknown): boolean {
  return (
    error instanceof CliError &&
    error.code === "provider_error" &&
    /cannot find|does not exist|no such file/i.test(error.message)
  );
}

/** A generated installer file name: `<slug>.php` or `<slug>.php.part`. */
function installerSlug(name: string): string | undefined {
  const match = /^(.+)\.php(?:\.part)?$/.exec(name);
  return match?.[1] !== undefined && SLUG.test(match[1]) ? match[1] : undefined;
}

async function entries(
  api: CpanelApi,
  dir: string,
  types: "file" | "dir",
  signal?: AbortSignal,
): Promise<{ readonly name: string; readonly mtime: number | undefined }[]> {
  let rows: unknown;
  try {
    rows = await api.uapi("Fileman", "list_files", { dir, types }, { signal });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  if (!Array.isArray(rows))
    throw new CliError(
      "provider_error",
      "cPanel returned an invalid file list.",
    );
  return rows.flatMap((row) => {
    const record = asRecord(row);
    const mtime = Number(record?.mtime);
    return typeof record?.file === "string"
      ? [
          {
            name: record.file,
            mtime: Number.isFinite(mtime) && mtime > 0 ? mtime : undefined,
          },
        ]
      : [];
  });
}

async function read(
  api: CpanelApi,
  dir: string,
  file: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const content = asRecord(
      await api.uapi("Fileman", "get_file_content", { dir, file }, { signal }),
    )?.content;
    return typeof content === "string" ? content : undefined;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** `true` when the path is gone afterwards; never throws. */
async function remove(
  api: CpanelApi,
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await api.uapi("Fileman", "delete_file", { path }, { signal });
    return true;
  } catch (error) {
    return missing(error);
  }
}

/**
 * Removes setup files earlier runs left behind, by exact generated name only.
 * A generated file or working directory younger than ten minutes, or whose
 * age cPanel does not report, belongs to a run that may still be going, so
 * setup stops instead of touching anything.
 */
export async function removeLeftovers(
  api: CpanelApi,
  site: CpanelWordPress,
  now: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const content = `${site.documentRoot}/wp-content`;
  const installers = (
    await entries(api, `${content}/mu-plugins`, "file", signal)
  ).filter((entry) => installerSlug(entry.name) !== undefined);
  const directories = (await entries(api, content, "dir", signal)).filter(
    (entry) => SLUG.test(entry.name),
  );
  if (
    [...installers, ...directories].some(
      (entry) => entry.mtime === undefined || now - entry.mtime < TEN_MINUTES,
    )
  )
    throw new CliError("conflict", CONFLICT_MESSAGE);
  const removed: string[] = [];
  for (const path of [
    ...installers.map((entry) => `${content}/mu-plugins/${entry.name}`),
    ...directories.map((entry) => `${content}/${entry.name}`),
  ])
    if (await remove(api, path, signal)) removed.push(path);
  return removed;
}

/** The supported existing Novamira's version, or `undefined` when absent. */
async function existingVersion(
  api: CpanelApi,
  site: CpanelWordPress,
  signal: AbortSignal,
): Promise<string | undefined> {
  const [row, ...rest] = await novamiraPluginRowsFromFiles(
    api,
    site.documentRoot,
    signal,
  );
  if (row === undefined) return undefined;
  const version = row.version;
  if (rest.length > 0 || typeof version !== "string" || !isSemver(version))
    throw new CliError(
      "provider_error",
      "Novamira is present on this site, but its version could not be read. Check Plugins in WordPress.",
    );
  if (compareSemverStrings(version, MINIMUM_NOVAMIRA_VERSION) < 0)
    throw new CliError(
      "server_unsupported",
      "Update the existing Novamira installation before setup; it will not be overwritten.",
    );
  return version;
}

async function upload(
  api: CpanelApi,
  dir: string,
  filename: string,
  bytes: Uint8Array,
  contentType: string,
  signal: AbortSignal,
): Promise<void> {
  const data = asRecord(
    await api.uapiMultipart(
      "Fileman",
      "upload_files",
      {
        kind: "multipart",
        fields: { dir, overwrite: "0" },
        files: [{ field: "file-1", filename, contentType, bytes }],
      },
      { signal, timeoutMs: 120_000 },
    ),
  );
  const uploads = Array.isArray(data?.uploads) ? data.uploads : [];
  const reported = asRecord(uploads[0]);
  if (
    data?.succeeded !== 1 ||
    uploads.length !== 1 ||
    reported?.file !== filename ||
    Number(reported.size) !== bytes.length
  )
    throw new CliError(
      "provider_error",
      `cPanel did not confirm the upload of ${filename}. Nothing was installed.`,
    );
}

/** Bound for the readiness document; anything larger is not Novamira's. */
const METADATA_MAX_BYTES = 64 * 1024;

/**
 * The one direct site request: unauthenticated `Accept` + `User-Agent` only,
 * no redirects followed. With `read`, a 200 JSON body (bounded) is returned;
 * otherwise the body is cancelled and `undefined` returned. Transport errors
 * are not failures here; aborts are.
 */
async function siteRequest(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  read = false,
): Promise<unknown> {
  try {
    const response = await fetcher(url, {
      method: "GET",
      // No Authorization, no Cookie. Ever.
      headers: {
        Accept: "application/json",
        "User-Agent": SITE_REQUEST_USER_AGENT,
      },
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!read || response.status !== 200) {
      await discardBody(response);
      return undefined;
    }
    const text = await readBoundedText(response, METADATA_MAX_BYTES);
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

/** Whether the site already serves Novamira's public readiness document. */
async function alreadyServed(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<boolean> {
  const metadata = asRecord(await siteRequest(fetcher, url, signal, true));
  return typeof asRecord(metadata?.novamira)?.plugin_version === "string";
}

type InstallerStatus =
  | { readonly ok: true; readonly version: string; readonly aiEnabled: boolean }
  | { readonly ok: false; readonly error: string };

function parseStatus(content: string | undefined): InstallerStatus | undefined {
  if (content === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    // Possibly read while the installer was still writing it.
    return undefined;
  }
  const record = asRecord(value);
  if (record?.ok === true && typeof record.version === "string")
    return {
      ok: true,
      version: record.version,
      aiEnabled: record.aiEnabled === true,
    };
  const error =
    typeof record?.error === "string" && /^[a-z_]{1,32}$/.test(record.error)
      ? record.error
      : "unknown";
  return { ok: false, error };
}

function installerFailure(code: string): CliError {
  return new CliError(
    "provider_error",
    INSTALLER_ERRORS[code] ??
      `The temporary installer could not install Novamira (${code}).`,
  );
}

/**
 * Whether the installer left signs of a run in its working directory: the
 * lock it takes first, or the payload it extracts. A directory cPanel cannot
 * list counts as started, so its files are never removed early.
 */
async function runStarted(
  api: CpanelApi,
  workDir: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const files = await entries(api, workDir, "file", signal);
    const directories = await entries(api, workDir, "dir", signal);
    return (
      files.some((entry) => entry.name === "lock") ||
      directories.some((entry) => entry.name === "payload")
    );
  } catch {
    signal.throwIfAborted();
    return true;
  }
}

/**
 * Turns a cancellation or the setup's own time limit, which arrive as plain
 * DOM exceptions, into an error the user can act on. Errors HQ already
 * described (including an abort reason given as a CliError) pass unchanged.
 */
function interruption(
  error: unknown,
  cancelled: boolean,
  timedOut: boolean,
  placed: boolean,
): unknown {
  if (error instanceof CliError) return error;
  const name = error instanceof Error ? error.name : undefined;
  const timeout = !cancelled && (timedOut || name === "TimeoutError");
  if (!cancelled && !timeout && name !== "AbortError") return error;
  const what = timeout ? "ran out of time" : "was cancelled";
  return new CliError(
    timeout ? "timeout" : "network_error",
    placed
      ? `Novamira setup ${what} after the temporary installer was placed, so its outcome on the site is unknown. Check Plugins in WordPress before retrying.`
      : `Novamira setup ${what} before the temporary installer was placed; nothing was installed.`,
    { cause: error },
  );
}

export async function setupWithInstaller(
  api: CpanelApi,
  fetcher: typeof fetch,
  site: CpanelWordPress,
  request: SetupRequest,
  deps: InstallerSetupDependencies,
): Promise<ActionResult> {
  if (request.allowTemporaryInstaller !== true)
    throw new CliError("confirmation_required", CONSENT_MESSAGE);
  const url = rootHttpsUrl(site);
  if (site.version === undefined)
    throw new CliError(
      "server_unsupported",
      "The WordPress version of this site could not be read; install Novamira from WordPress → Plugins, then connect the site by URL.",
    );
  if (!wordpressSupported(site.version))
    throw new CliError(
      "server_unsupported",
      "Novamira setup requires WordPress 6.9 or newer.",
    );
  const deadline = AbortSignal.timeout(300_000);
  const signal = request.signal
    ? AbortSignal.any([request.signal, deadline])
    : deadline;
  const root = site.documentRoot;
  const content = `${root}/wp-content`;

  // Preconditions, read-only except the removal of expired generated leftovers.
  await removeLeftovers(api, site, Math.floor(deps.now() / 1000), signal);
  const htaccess = await read(api, root, ".htaccess", signal);
  if (
    htaccess === undefined ||
    !htaccess.includes("# BEGIN WordPress") ||
    !htaccess.includes("RewriteRule . /index.php")
  )
    throw new CliError("provider_unsupported", PERMALINKS_MESSAGE);
  const existing = await existingVersion(api, site, signal);
  const enableAi = request.enableAiAbilities ?? existing === undefined;
  const metadataUrl = `${url.origin}${PROTECTED_RESOURCE_PATH}`;
  // An existing Novamira the site already serves needs no write at all when
  // AI Abilities are not requested: activation cannot be read from files, so
  // the public readiness document is the evidence it is active.
  if (
    existing !== undefined &&
    !enableAi &&
    (await alreadyServed(fetcher, metadataUrl, signal))
  )
    return {
      provider: "cpanel",
      action: "novamira.setup",
      status: 200,
      raw: {
        siteUrl: site.siteUrl,
        version: existing,
        aiEnabled: null,
        warnings: [],
      },
    };
  const archive =
    existing === undefined
      ? await downloadNovamiraArchive(fetcher, signal, "cPanel")
      : undefined;
  signal.throwIfAborted();

  const slug = `novamira-hq-setup-${deps.uuid()}`;
  if (!SLUG.test(slug))
    throw new CliError("internal_error", "Invalid setup directory name.");
  const workDir = `${content}/${slug}`;
  const muPlugins = `${content}/mu-plugins`;

  let outcome: InstallerStatus | undefined;
  let failure: { readonly error: unknown } | undefined;
  /** From the rename on, the installer may be live on the site. */
  let placed = false;
  try {
    // The working directory first, closed to web requests before anything
    // else lands in it, then the ZIP (none when Novamira is already present),
    // the installer last: it never runs without them.
    await upload(
      api,
      workDir,
      ".htaccess",
      new TextEncoder().encode(DENY_ALL),
      "text/plain",
      signal,
    );
    await upload(
      api,
      workDir,
      "index.php",
      new Uint8Array(),
      "application/x-php",
      signal,
    );
    if (archive !== undefined)
      await upload(
        api,
        workDir,
        "novamira.zip",
        archive,
        "application/zip",
        signal,
      );
    // A cancellation that arrived during the uploads stops before the
    // installer exists anywhere.
    signal.throwIfAborted();
    const installer = new TextEncoder().encode(
      cpanelInstaller({
        slug,
        domain: url.hostname,
        digest:
          archive === undefined
            ? null
            : createHash("sha256").update(archive).digest("hex"),
        enableAi,
        minimumVersion: MINIMUM_NOVAMIRA_VERSION,
        ttl: INSTALLER_TTL,
      }),
    );
    // WordPress loads only `*.php` must-use plugins, so a partial `.part` is
    // inert; the same-directory rename makes the installer appear whole.
    await upload(
      api,
      muPlugins,
      `${slug}.php.part`,
      installer,
      "application/x-php",
      signal,
    );
    placed = true;
    await api.uapi(
      "Fileman",
      "rename_file",
      {
        source: `${muPlugins}/${slug}.php.part`,
        destination: `${muPlugins}/${slug}.php`,
      },
      { method: "POST", signal },
    );

    await siteRequest(fetcher, metadataUrl, signal);
    for (let poll = 0; ; poll++) {
      outcome = parseStatus(await read(api, workDir, "status.json", signal));
      if (outcome !== undefined || poll >= POLLS) break;
      if (poll === RETRIGGER_AT)
        await siteRequest(fetcher, metadataUrl, signal);
      await deps.sleep(POLL_MS, signal);
    }
  } catch (error) {
    failure = { error };
  }

  // Whatever happened above, with fresh deadlines: cancellation must not
  // leave files behind. The installer goes first, so no new run can start.
  const warnings: string[] = [];
  const removeOrWarn = async (path: string): Promise<void> => {
    if (!(await remove(api, path, AbortSignal.timeout(30_000))))
      warnings.push(
        `Novamira HQ could not remove ${path} from the site. Delete it in cPanel → File Manager.`,
      );
  };
  await removeOrWarn(`${muPlugins}/${slug}.php`);
  await removeOrWarn(`${muPlugins}/${slug}.php.part`);
  if (failure === undefined && outcome === undefined) {
    // A run that took its lock or started extracting may still be working;
    // its directory stays until it reports or its lifetime is over.
    const waiting = request.signal
      ? AbortSignal.any([
          request.signal,
          AbortSignal.timeout((INSTALLER_TTL + 30) * 1000),
        ])
      : AbortSignal.timeout((INSTALLER_TTL + 30) * 1000);
    try {
      if (await runStarted(api, workDir, waiting))
        for (let poll = 0; poll < INSTALLER_TTL / (POLL_MS / 1000); poll++) {
          await deps.sleep(POLL_MS, waiting);
          outcome = parseStatus(
            await read(api, workDir, "status.json", waiting),
          );
          if (outcome !== undefined) break;
        }
    } catch (error) {
      // A cancellation is reported as one; a failed read only ends the wait.
      if (request.signal?.aborted === true) failure = { error };
    }
  }
  await removeOrWarn(workDir);

  // Paths that could not be removed travel with the error, in its message and
  // in `details.warnings`, so the user can delete them by hand. Anything that
  // is not a CliError and not an interruption is rethrown untouched.
  const withWarnings = (error: unknown): unknown =>
    warnings.length === 0 || !(error instanceof CliError)
      ? error
      : new CliError(error.code, `${error.message} ${warnings.join(" ")}`, {
          retryable: error.retryable,
          ...(error.remoteCode === undefined
            ? {}
            : { remoteCode: error.remoteCode }),
          details: { ...error.details, warnings },
          cause: error.cause,
        });
  if (failure !== undefined)
    throw withWarnings(
      interruption(
        failure.error,
        request.signal?.aborted === true,
        deadline.aborted,
        placed,
      ),
    );
  if (outcome === undefined)
    throw withWarnings(new CliError("provider_error", NO_REPORT_MESSAGE));
  if (!outcome.ok) throw withWarnings(installerFailure(outcome.error));
  if (
    !isSemver(outcome.version) ||
    compareSemverStrings(outcome.version, MINIMUM_NOVAMIRA_VERSION) < 0 ||
    outcome.aiEnabled !== enableAi
  )
    throw withWarnings(
      new CliError(
        "provider_error",
        "The temporary installer reported a result HQ could not verify. Check Plugins in WordPress.",
      ),
    );
  return {
    provider: "cpanel",
    action: "novamira.setup",
    status: 200,
    raw: {
      siteUrl: site.siteUrl,
      version: outcome.version,
      aiEnabled: outcome.aiEnabled ? true : null,
      warnings,
    },
  };
}
