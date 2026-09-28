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
} from "../dist/config/file-security.js";

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
