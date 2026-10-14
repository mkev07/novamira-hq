// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The official Novamira archive download shared by every provider setup. */

import { CliError } from "../errors.js";

export const NOVAMIRA_SOURCE =
  "https://license.dynamic.ooo/api/novamira/download";
export const NOVAMIRA_ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;

function fail(message: string): never {
  throw new CliError("provider_error", message);
}

/**
 * One bounded provider transfer: no automatic redirects (except the download
 * allowlist's first hop) and no retry. Failures never echo fetch internals.
 */
export async function providerTransfer(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
  allowDownloadRedirect = false,
): Promise<Response> {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: allowDownloadRedirect ? "manual" : "error",
    });
    if (
      allowDownloadRedirect &&
      [301, 302, 303, 307, 308].includes(response.status)
    )
      return response;
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        `${label} setup transfer failed (HTTP ${String(response.status)}). No automatic retry was made.`,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof CliError) throw error;
    // Fetch errors may embed opaque upload URLs or header values.
    fail(
      `${label} setup transfer failed or timed out. Verify the site before retrying.`,
    );
  }
}

/**
 * Downloads the official Novamira ZIP: one trusted redirect, a size ceiling
 * and a ZIP signature check. `label` names the provider in failures.
 */
export async function downloadNovamiraArchive(
  fetcher: typeof fetch,
  signal: AbortSignal,
  label: string,
): Promise<Uint8Array> {
  let response = await providerTransfer(
    fetcher,
    NOVAMIRA_SOURCE,
    {
      signal,
      headers: { Accept: "application/zip" },
    },
    label,
    true,
  );
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    let target: URL;
    try {
      target = new URL(location ?? "", NOVAMIRA_SOURCE);
    } catch {
      fail("The official Novamira download returned an invalid redirect.");
    }
    if (
      target.origin !== "https://nbg1.your-objectstorage.com" ||
      !/^\/ooo-zips-free\/novamira\/versions\/novamira-[a-zA-Z0-9._-]+\.zip$/.test(
        target.pathname,
      ) ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    )
      fail(
        "The official Novamira download redirected outside its trusted archive location.",
      );
    response = await providerTransfer(
      fetcher,
      target.href,
      {
        signal,
        headers: { Accept: "application/zip" },
      },
      label,
    );
  }
  if (
    Number(response.headers.get("content-length")) > NOVAMIRA_ARCHIVE_MAX_BYTES
  ) {
    await response.body?.cancel();
    fail("The Novamira archive exceeds the setup size limit.");
  }
  if (!response.body) fail("The Novamira archive is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > NOVAMIRA_ARCHIVE_MAX_BYTES) {
        await reader.cancel();
        fail("The Novamira archive exceeds the setup size limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
    fail("The Novamira download is not a ZIP archive.");
  return bytes;
}
