// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// ponytail: headless fork — patches the installed @novamira/cli so device-code polling backs
// off on `temporarily_unavailable` (the Novamira plugin's 429 rate limit) instead of failing
// the login. Remove once upstream novamira-cli handles it. Fails the build if the target moved.
import { readFileSync, writeFileSync } from "node:fs";
import console from "node:console";
import { fileURLToPath, URL } from "node:url";

const file = fileURLToPath(
  new URL("../node_modules/@novamira/cli/dist/auth/device.js", import.meta.url),
);
const from = 'if (error.remoteCode === "slow_down")';
const to =
  'if (error.remoteCode === "slow_down" || error.remoteCode === "temporarily_unavailable")';

const source = readFileSync(file, "utf8");
if (source.includes(to)) {
  console.log("site CLI already patched");
} else if (source.includes(from)) {
  writeFileSync(file, source.replace(from, to));
  console.log(
    "site CLI patched: device polling backs off on temporarily_unavailable",
  );
} else {
  throw new Error(
    `patch-site-cli: target not found in ${file}; re-check the fork patch`,
  );
}
