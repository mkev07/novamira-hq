// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SpawnCommandRunner,
  WindowsFileSecurity,
  aclWorkerRequest,
} from "../dist/config/file-security.js";

test("ACL worker requests stay ASCII and keep non-ASCII paths exact", () => {
  const checks = [
    { path: "C:\\Users\\\u00d6z\u00fcn \u015e\u00e7\\State", directory: true },
    { path: "C:\\Users\\Jos\u00e9\\config.json", directory: false },
    { path: "C:\\Users\\\u{1f600}\\x", directory: false },
  ];
  const line = aclWorkerRequest(checks);
  assert.match(line, /^[\x20-\x7e]*$/);
  assert.deepEqual(JSON.parse(line), checks);
});

test(
  "native Windows storage becomes private for the current user",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hq-acl-contract-"));
    const runner = new SpawnCommandRunner();
    const security = new WindowsFileSecurity({
      run: runner.run.bind(runner),
      runOutput: runner.runOutput.bind(runner),
    });
    try {
      await security.secureDirectory(root);
      assert.equal(await security.verifyDirectory(root), true);
      await security.secureDirectory(root);
      assert.equal(await security.verifyDirectory(root), true);
      const file = join(root, "record.json");
      await writeFile(file, "{}");
      await security.secureFile(file);
      assert.equal(await security.verifyFile(file), true);
      await security.secureFile(file);
      assert.equal(await security.verifyFile(file), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "native Windows ACL worker verifies a non-ASCII storage path",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "hq-acl-\u00d6z\u00fcn-Jos\u00e9-"),
    );
    const security = new WindowsFileSecurity();
    try {
      await security.secureDirectory(root);
      const file = join(root, "record.json");
      await writeFile(file, "{}");
      await security.secureFile(file);
      assert.deepEqual(
        await Promise.all([
          security.verifyDirectory(root),
          security.verifyFile(file),
        ]),
        [true, true],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
