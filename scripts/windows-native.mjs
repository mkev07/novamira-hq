// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

export const WEBVIEW_VERSION = "0.9.0";
export const WINDOWS_WEBVIEW_HASHES = Object.freeze({
  "webview.dll":
    "fec1e559a6ff67e695416b5cf42221eb319ea3ccb6719c05dbd2ae01a3c9810a",
  "WebView2Loader.dll":
    "184574b9c36b044888644fc1f2b19176e0e76ccc3ddd2f0a5f0d618c88661f86",
});

/** Download only while building; the desktop executable uses embedded files. */
export async function installWindowsWebview(
  directory,
  fetcher = globalThis.fetch,
) {
  const config = JSON.parse(
    await readFile(new URL("../desktop/deno.json", import.meta.url), "utf8"),
  );
  if (
    config.imports["@webview/webview"] !==
    `jsr:@webview/webview@${WEBVIEW_VERSION}`
  )
    throw new Error(
      "Update the Windows native webview hashes with its version",
    );
  await mkdir(directory, { recursive: true });
  for (const [filename, expected] of Object.entries(WINDOWS_WEBVIEW_HASHES)) {
    const response = await fetcher(
      `https://github.com/webview/webview_deno/releases/download/${WEBVIEW_VERSION}/${filename}`,
      { signal: globalThis.AbortSignal.timeout(30_000) },
    );
    if (!response.ok)
      throw new Error(
        `Native webview download failed: HTTP ${response.status}`,
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error(`Native webview checksum mismatch: ${filename}`);
    await writeFile(join(directory, filename), bytes);
  }
  return directory;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3)
    throw new Error("Usage: windows-native.mjs <output-directory>");
  process.stdout.write(`${await installWindowsWebview(process.argv[2])}\n`);
}
