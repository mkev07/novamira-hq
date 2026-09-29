// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Headless fork: `NOVAMIRA_HQ_DEVICE_LOGIN=1` makes Connect run `auth login --device` and hand
// the verification page and code to the dashboard while the child is still waiting.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createConnectAction,
  parseDeviceInstructions,
} from "../dist/integration/connect.js";

const SITE = "https://example.com";
const PROMPT =
  "Open this page in a browser on any device:\n" +
  "https://example.com/wp-admin/admin.php?page=novamira-oauth-device\n" +
  "Enter the code: MKPW-HDHL\n" +
  "The code expires in 10 minutes. Waiting for approval...\n";

test("parseDeviceInstructions reads the page and code from the site CLI prompt", () => {
  assert.deepEqual(parseDeviceInstructions(PROMPT, SITE), {
    url: "https://example.com/wp-admin/admin.php?page=novamira-oauth-device",
    code: "MKPW-HDHL",
  });
  assert.equal(parseDeviceInstructions("Open this page", SITE), undefined);
});

test("parseDeviceInstructions refuses a page on another origin", () => {
  assert.equal(
    parseDeviceInstructions(
      PROMPT.replaceAll("example.com", "evil.test"),
      SITE,
    ),
    undefined,
  );
});

test("device mode passes --device and reports the prompt before the child exits", async () => {
  const seen = [];
  let args;
  const connect = createConnectAction({
    environment: { NOVAMIRA_HQ_DEVICE_LOGIN: "1" },
    resolve: async () => ({ command: "novamira", prefixArgs: [] }),
    spawn: async (invocation) => {
      args = invocation.args;
      invocation.onStderr?.(PROMPT.slice(0, 40));
      invocation.onStderr?.(PROMPT);
      invocation.onStderr?.(PROMPT + "more\n");
      return {
        kind: "exited",
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {},
          meta: { requestId: "r" },
        }),
        stderr: PROMPT,
      };
    },
  });

  const outcome = await connect(SITE, undefined, (device) => seen.push(device));

  assert.deepEqual(outcome, { kind: "connected" });
  assert.ok(args.includes("--device"));
  assert.deepEqual(seen, [
    {
      url: "https://example.com/wp-admin/admin.php?page=novamira-oauth-device",
      code: "MKPW-HDHL",
    },
  ]);
});

test("without the flag, Connect keeps the browser login", async () => {
  let args;
  const connect = createConnectAction({
    environment: {},
    resolve: async () => ({ command: "novamira", prefixArgs: [] }),
    spawn: async (invocation) => {
      args = invocation.args;
      assert.equal(invocation.onStderr, undefined);
      return {
        kind: "exited",
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {},
          meta: { requestId: "r" },
        }),
        stderr: "",
      };
    },
  });
  await connect(SITE, undefined, () =>
    assert.fail("no device prompt expected"),
  );
  assert.ok(!args.includes("--device"));
});
