// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Whole-account cPanel backups in the home directory, and domain error logs. */

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import type { CpanelApi } from "./cpanel-uapi.js";

export interface CpanelBackup {
  readonly id: string;
  readonly filename: string;
  readonly size_bytes: number;
  readonly created_at: string;
}

const POLL_INTERVAL_MS = 10_000;
const BACKUP_DEADLINE_MS = 30 * 60_000;
const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 5000;

/** `backup-<M>.<D>.<YYYY>_<HH>-<MM>-<SS>_<username>.tar.gz`. */
function backupPattern(username: string): RegExp {
  // The username was validated against `[a-z][a-z0-9_-]*` by the API factory.
  return new RegExp(
    `^backup-(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})_(\\d{2})-(\\d{2})-(\\d{2})_${username}\\.tar\\.gz$`,
  );
}

export async function listHomeBackups(
  api: CpanelApi,
  signal?: AbortSignal,
): Promise<CpanelBackup[]> {
  const rows = await api.uapi(
    "Fileman",
    "list_files",
    { dir: "", types: "file" },
    { signal },
  );
  if (!Array.isArray(rows))
    throw new CliError(
      "provider_error",
      "cPanel returned an invalid file list.",
    );
  const pattern = backupPattern(api.username);
  const backups: CpanelBackup[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    const name = record?.file;
    if (typeof name !== "string") continue;
    const match = pattern.exec(name);
    if (!match) continue;
    const size = Number(record?.size);
    if (!Number.isSafeInteger(size) || size < 0) continue;
    const [, month, day, year, hour, minute, second] = match;
    if (
      month === undefined ||
      day === undefined ||
      year === undefined ||
      hour === undefined ||
      minute === undefined ||
      second === undefined
    )
      continue;
    // cPanel names the file in the server's local time and states no zone. The
    // dashboard only formats timestamps that carry one, so this is labelled as
    // UTC, which is exact on the usual UTC-clocked hosts.
    const createdAt = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour}:${minute}:${second}Z`;
    if (!Number.isFinite(Date.parse(createdAt))) continue;
    backups.push({
      id: name,
      filename: name,
      size_bytes: size,
      created_at: createdAt,
    });
  }
  return backups.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Starts the asynchronous whole-account backup into the home directory.
 *
 * Sent as POST, which the HTTP client never replays: repeating this request
 * after a transient failure would start a second whole-account backup.
 */
export async function startAccountBackup(
  api: CpanelApi,
  signal?: AbortSignal,
): Promise<void> {
  await api.uapi(
    "Backup",
    "fullbackup_to_homedir",
    {},
    { method: "POST", signal },
  );
}

export interface WaitForBackupOptions {
  /** Resolves after `ms`; rejects when `signal` aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Resolves with the file name of the first backup that is not in `before` and
 * keeps the same non-zero size across two polls 10 seconds apart. Aborting
 * `options.signal` ends the wait with the abort error.
 */
export async function waitForNewBackup(
  api: CpanelApi,
  before: ReadonlySet<string>,
  options: WaitForBackupOptions,
): Promise<string> {
  const { signal } = options;
  const started = Date.now();
  let waited = 0;
  let last: { id: string; size: number } | undefined;
  // The slept time bounds the loop even when the clock is not advancing.
  while (Math.max(waited, Date.now() - started) < options.deadlineMs) {
    signal?.throwIfAborted();
    await options.sleep(POLL_INTERVAL_MS, signal);
    // A sleep that ignores the signal must not lead to another request.
    signal?.throwIfAborted();
    waited += POLL_INTERVAL_MS;
    const fresh = (await listHomeBackups(api, signal)).find(
      (entry) => !before.has(entry.id),
    );
    if (
      fresh &&
      last?.id === fresh.id &&
      last.size === fresh.size_bytes &&
      fresh.size_bytes > 0
    )
      return fresh.id;
    last = fresh ? { id: fresh.id, size: fresh.size_bytes } : undefined;
  }
  throw new CliError(
    "timeout",
    "cPanel started the account backup but it did not finish in time. It may still complete; check the home directory in cPanel File Manager.",
  );
}

/** Backs up the whole account and returns the new backup's file name. */
export async function createAccountBackup(
  api: CpanelApi,
  sleep: WaitForBackupOptions["sleep"],
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly deadlineMs?: number;
  } = {},
): Promise<string> {
  const { signal } = options;
  signal?.throwIfAborted();
  const before = new Set(
    (await listHomeBackups(api, signal)).map((entry) => entry.id),
  );
  signal?.throwIfAborted();
  await startAccountBackup(api, signal);
  return waitForNewBackup(api, before, {
    sleep,
    signal,
    deadlineMs: options.deadlineMs ?? BACKUP_DEADLINE_MS,
  });
}

export async function readErrorLog(
  api: CpanelApi,
  domain: string,
  lines: number,
): Promise<{ lines: string[] }> {
  const maxlines = String(
    Math.min(
      Math.max(Math.trunc(lines) || DEFAULT_LOG_LINES, 1),
      MAX_LOG_LINES,
    ),
  );
  const rows = await api.uapi("Stats", "get_site_errors", {
    domain,
    log: "error",
    maxlines,
  });
  // A domain without an error log yet may answer without data.
  if (rows === null || rows === undefined) return { lines: [] };
  if (!Array.isArray(rows))
    throw new CliError(
      "provider_error",
      "cPanel returned an invalid error log.",
    );
  return {
    lines: rows
      .map((row) => asRecord(row)?.entry)
      .filter((entry): entry is string => typeof entry === "string"),
  };
}
