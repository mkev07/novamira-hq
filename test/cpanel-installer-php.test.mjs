// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, utimesSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import { cpanelInstaller } from "../dist/hosting/providers/cpanel-installer.js";

const phpAvailable = spawnSync("php", ["-v"]).status === 0;
const zipAvailable =
  phpAvailable &&
  spawnSync("php", ["-r", "exit(class_exists('ZipArchive') ? 0 : 1);"])
    .status === 0;
const zipCli = spawnSync("zip", ["-v"]).status === 0;
const NO_ZIP_CLI = "the zip command is not installed";
const SLUG = "novamira-hq-setup-00000000-0000-4000-8000-000000000001";

const source = cpanelInstaller({
  slug: SLUG,
  domain: "example.com",
  digest: null,
  enableAi: true,
  minimumVersion: "1.11.1",
  ttl: 180,
});

test("the installer source never reads request data, never stops the request and holds no secrets", () => {
  for (const forbidden of [
    "$_GET",
    "$_POST",
    "$_REQUEST",
    "$_SERVER",
    "$_COOKIE",
    "php://input",
    "wp_die",
    "exit",
    "die(",
    "eval(",
    "base64_decode($_",
    "Authorization",
  ])
    assert.ok(!source.includes(forbidden), forbidden);
  assert.match(source, /flock\(/);
  assert.match(source, /LOCK_EX \| LOCK_NB/);
  assert.match(source, /hash_file\('sha256'/);
  assert.match(source, /unlink\(__FILE__\)/);
  assert.match(source, /status\.json/);
  assert.match(source, /add_action\('init'/);
});

test("the installer refuses a slug that is not a generated setup name", () => {
  for (const slug of [
    "",
    "novamira-hq-setup-",
    "../novamira-hq-setup-00000000-0000-4000-8000-000000000001",
    "novamira-hq-setup-00000000-0000-4000-8000-00000000000'",
    "novamira-hq-setup-00000000-0000-4000-8000-0000000000012",
    "other-00000000-0000-4000-8000-000000000001",
  ])
    assert.throws(
      () =>
        cpanelInstaller({
          slug,
          domain: "example.com",
          digest: null,
          enableAi: true,
          minimumVersion: "1.11.1",
          ttl: 180,
        }),
      /invalid installer slug/,
      slug,
    );
});

test("the installer carries values as base64 JSON, never as PHP source", () => {
  const hostile = cpanelInstaller({
    slug: SLUG,
    domain: "evil'.phpinfo().'.example",
    digest: null,
    enableAi: false,
    minimumVersion: "1.11.1",
    ttl: 7,
  });
  assert.ok(!hostile.includes("phpinfo"));
  const match = /base64_decode\('([A-Za-z0-9+/=]+)'\)/.exec(hostile);
  assert.ok(match);
  assert.deepEqual(JSON.parse(Buffer.from(match[1], "base64").toString()), {
    domain: "evil'.phpinfo().'.example",
    digest: null,
    enableAi: false,
    minimumVersion: "1.11.1",
    ttl: 7,
  });
});

test("the installer source uses no PHP 7-only syntax, so older PHP reaches its requirements check", () => {
  assert.ok(!source.includes(")()"), "immediately invoked closure");
  assert.ok(!source.includes("??"), "null coalescing");
  assert.ok(!/function\s*\([^)]*\)\s*:/.test(source), "return type");
  assert.ok(!/\b(?:string|int|float|bool)\s+\$/.test(source), "scalar type");
  assert.ok(source.includes(String.raw`catch (\Exception $e)`));
});

test("the installer silences its own output and warnings and creates status.json exclusively", () => {
  assert.match(source, /ob_start\(\);/);
  assert.match(source, /ob_end_clean\(\)/);
  assert.match(source, /set_error_handler\(/);
  assert.match(source, /restore_error_handler\(\)/);
  assert.match(source, /fopen\(\$status, 'x'\)/);
  assert.ok(!source.includes("file_put_contents"));
  assert.match(source, /filemtime\(__FILE__\)/);
});

test(
  "the generated PHP keeps its escapes and parses",
  { skip: !phpAvailable },
  async () => {
    assert.ok(source.includes(String.raw`str_contains($name, '\\')`));
    assert.ok(source.includes(String.raw`str_contains($name, "\0")`));
    assert.ok(
      source.includes(String.raw`preg_match('~(^|/)\.\.?(/|$)~', $name)`),
    );
    assert.ok(source.includes(String.raw`catch (\Throwable $e)`));
    const root = await mkdtemp(join(tmpdir(), "hq-cpanel-lint-"));
    try {
      const file = join(root, "installer.php");
      await writeFile(file, source);
      const lint = spawnSync("php", ["-l", file], { encoding: "utf8" });
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
      assert.match(lint.stdout, /No syntax errors detected/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * A WordPress-shaped sandbox that loads the mu-plugin and fires `init`.
 * `age` back-dates the installer file (its expiry runs from its mtime).
 */
async function sandbox({
  ttl = 180,
  age = 0,
  installed = "1.12.8",
  multisite = false,
  preinstalled = true,
  digest = null,
  enableAi = true,
  archive,
  wordpress = "7.1.3",
  activation = "ok",
  noisy = false,
  vanish = false,
  unzip = "full",
}) {
  const root = await mkdtemp(join(tmpdir(), "hq-cpanel-installer-"));
  const content = join(root, "wp-content");
  await mkdir(join(content, "mu-plugins"), { recursive: true });
  await mkdir(join(content, SLUG), { recursive: true });
  await mkdir(join(root, "wp-admin/includes"), { recursive: true });
  await writeFile(join(root, "wp-admin/includes/plugin.php"), "<?php");
  await writeFile(join(root, "wp-admin/includes/file.php"), "<?php");
  if (preinstalled) {
    await mkdir(join(content, "plugins/novamira"), { recursive: true });
    await writeFile(
      join(content, "plugins/novamira/novamira.php"),
      "<?php /* installed */",
    );
  } else {
    await mkdir(join(content, "plugins"), { recursive: true });
  }
  if (archive) await writeFile(join(content, SLUG, "novamira.zip"), archive);
  const file = join(content, "mu-plugins", `${SLUG}.php`);
  await writeFile(
    file,
    cpanelInstaller({
      slug: SLUG,
      domain: "example.com",
      digest,
      enableAi,
      minimumVersion: "1.11.1",
      ttl,
    }),
  );
  if (age > 0) {
    const then = Date.now() / 1000 - age;
    utimesSync(file, then, then);
  }
  // `activate_plugin` doubles: "ok" activates; "noise" activates and then
  // reports WordPress's unexpected_output; "noise-inactive" reports it without
  // activating; "error" fails with another code.
  const harness = `<?php
define('ABSPATH', __DIR__ . '/');
define('WP_CONTENT_DIR', __DIR__ . '/wp-content');
define('WP_PLUGIN_DIR', __DIR__ . '/wp-content/plugins');
define('WPMU_PLUGIN_DIR', __DIR__ . '/wp-content/mu-plugins');
$GLOBALS['actions'] = []; $GLOBALS['options'] = []; $GLOBALS['active'] = false;
class WP_Error { public $code; function __construct($code) { $this->code = $code; } function get_error_code() { return $this->code; } }
function add_action($hook, $fn, $priority = 10) { $GLOBALS['actions'][$hook][] = $fn; }
function is_multisite() { return ${multisite ? "true" : "false"}; }
function get_bloginfo($f) { return '${wordpress}'; }
function home_url() { return 'https://' . getenv('HQ_TEST_HOST'); }
function wp_parse_url($u, $c) { return parse_url($u, $c); }
function get_plugin_data($f, $m, $t) {
  ${vanish ? "if (str_contains($f, '/payload/')) { unlink($f); }" : ""}
  return ['Version' => '${installed}'];
}
function is_plugin_active($p) { return $GLOBALS['active']; }
function activate_plugin($p) {
  $mode = '${activation}';
  ${noisy ? "echo 'noise'; trigger_error('user warning', E_USER_WARNING); trigger_error('user notice', E_USER_NOTICE); trigger_error('user deprecated', E_USER_DEPRECATED); $a = []; $b = $a['missing']; file_get_contents(__DIR__ . '/nothing-here');" : ""}
  if ($mode === 'error') { return new WP_Error('plugin_invalid'); }
  if ($mode === 'noise-inactive') { return new WP_Error('unexpected_output'); }
  $GLOBALS['active'] = true;
  return $mode === 'noise' ? new WP_Error('unexpected_output') : null;
}
function is_wp_error($x) { return $x instanceof WP_Error; }
function wp_clean_plugins_cache() {}
function update_option($k, $v) { $GLOBALS['options'][$k] = $v; return true; }
function get_option($k) { return $GLOBALS['options'][$k] ?? false; }
function WP_Filesystem() { return true; }
function unzip_file($archive, $to) {
  $zip = new ZipArchive();
  if ($zip->open($archive) !== true) { return new WP_Error('open'); }
  $ok = $zip->extractTo($to);
  $zip->close();
  if ('${unzip}' === 'partial') { unlink($to . '/novamira/includes/loader.php'); }
  if ('${unzip}' === 'short') { file_put_contents($to . '/novamira/includes/loader.php', 'x'); }
  if ('${unzip}' === 'slow') { sleep(2); }
  return $ok ? true : new WP_Error('extract');
}
require WPMU_PLUGIN_DIR . '/${SLUG}.php';
foreach ($GLOBALS['actions']['init'] ?? [] as $fn) { $fn(); }
echo json_encode(['options' => $GLOBALS['options'], 'active' => $GLOBALS['active']]);
`;
  await writeFile(join(root, "harness.php"), harness);
  const run = (host = "example.com") =>
    spawnSync(
      "php",
      [
        "-d",
        "display_errors=1",
        "-d",
        "error_reporting=-1",
        join(root, "harness.php"),
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, HQ_TEST_HOST: host },
      },
    );
  const statusFile = join(content, SLUG, "status.json");
  return {
    root,
    content,
    file,
    run,
    statusFile,
    status: () => readFile(statusFile, "utf8").then(JSON.parse),
  };
}

async function withBox(options, body) {
  const box = await sandbox(options);
  try {
    await body(box);
  } finally {
    await rm(box.root, { recursive: true, force: true });
  }
}

/** The harness prints exactly one JSON line; anything else leaked. */
function harnessOutput(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test(
  "an installed Novamira is activated, AI enabled, status written and the installer removed",
  { skip: !phpAvailable },
  () =>
    withBox({}, async (box) => {
      const out = harnessOutput(box.run());
      assert.equal(out.active, true);
      assert.equal(out.options.novamira_ai_abilities_enabled, "1");
      assert.deepEqual(await box.status(), {
        ok: true,
        version: "1.12.8",
        aiEnabled: true,
      });
      assert.equal(existsSync(box.file), false);
    }),
);

test(
  "the installer expires its ttl after its own file time, does nothing but report and remove itself",
  { skip: !phpAvailable },
  () =>
    withBox({ ttl: 180, age: 181 }, async (box) => {
      assert.equal(harnessOutput(box.run()).active, false);
      assert.deepEqual(await box.status(), { ok: false, error: "expired" });
      assert.equal(existsSync(box.file), false);
    }),
);

test(
  "a host mismatch writes nothing and keeps the installer; a later run on the right host succeeds",
  { skip: !phpAvailable },
  () =>
    withBox({}, async (box) => {
      assert.equal(harnessOutput(box.run("other.example")).active, false);
      assert.equal(existsSync(box.statusFile), false);
      assert.equal(existsSync(box.file), true);
      // The lock was released: the next run is not blocked.
      assert.equal(harnessOutput(box.run()).active, true);
      assert.equal((await box.status()).ok, true);
      assert.equal(existsSync(box.file), false);
    }),
);

test(
  "multisite or an old WordPress never activates anything and is reported",
  { skip: !phpAvailable },
  async () => {
    for (const [options, error] of [
      [{ multisite: true }, "multisite"],
      [{ wordpress: "6.8.2" }, "requirements"],
    ])
      await withBox(options, async (box) => {
        assert.equal(harnessOutput(box.run()).active, false, error);
        assert.deepEqual(await box.status(), { ok: false, error }, error);
        assert.equal(existsSync(box.file), false, error);
      });
  },
);

test(
  "a run after a completed run does nothing, never overwrites the status, and removes itself",
  { skip: !phpAvailable },
  () =>
    withBox({}, async (box) => {
      // The lock serialises runs within one burst of requests (exercised for
      // real on MAMP in Task 10); here: an existing status means "already done".
      const first = JSON.stringify({
        ok: true,
        version: "1.12.8",
        aiEnabled: true,
      });
      await writeFile(box.statusFile, first);
      assert.equal(harnessOutput(box.run()).active, false);
      assert.equal(await readFile(box.statusFile, "utf8"), first);
      assert.equal(existsSync(box.file), false);
    }),
);

test(
  "output and warnings during the run never reach the visitor, and unexpected_output with an active plugin is success",
  { skip: !phpAvailable },
  () =>
    withBox({ noisy: true, activation: "noise" }, async (box) => {
      const out = harnessOutput(box.run());
      assert.equal(out.active, true);
      assert.deepEqual(await box.status(), {
        ok: true,
        version: "1.12.8",
        aiEnabled: true,
      });
    }),
);

test(
  "an activation error, or unexpected_output while still inactive, is an activation failure",
  { skip: !phpAvailable },
  async () => {
    for (const activation of ["error", "noise-inactive"])
      await withBox({ activation }, async (box) => {
        assert.equal(harnessOutput(box.run()).active, false, activation);
        assert.deepEqual(
          await box.status(),
          { ok: false, error: "activation" },
          activation,
        );
      });
  },
);

/** Builds a ZIP with the system `zip` CLI inside its own empty directory. */
async function buildZip(entries) {
  const work = await mkdtemp(join(tmpdir(), "hq-cpanel-zip-"));
  const tree = join(work, "tree");
  await mkdir(tree);
  for (const [name, body] of Object.entries(entries)) {
    await mkdir(join(tree, name, ".."), { recursive: true });
    await writeFile(join(tree, name), body);
  }
  const zip = join(work, "novamira.zip");
  const run = spawnSync("zip", ["-qr", zip, "novamira"], { cwd: tree });
  assert.equal(run.status, 0, String(run.stderr));
  const bytes = await readFile(zip);
  await rm(work, { recursive: true, force: true });
  return bytes;
}

/**
 * A stored (uncompressed) ZIP with names and Unix modes exactly as given,
 * for entries the `zip` command refuses to write.
 */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, body = "", mode = 0o100644 } of entries) {
    const nameBytes = Buffer.from(name, "latin1");
    const data = Buffer.from(body);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PLUGIN = {
  "novamira/novamira.php": "<?php /* real plugin */",
  "novamira/includes/loader.php": "<?php /* loader */",
};

/** A fresh install of `bytes`, verified by its digest. */
const fresh = (bytes, extra = {}) => ({
  preinstalled: false,
  digest: sha256(bytes),
  archive: bytes,
  ...extra,
});

test(
  "a verified archive is extracted into plugins, activated, and the ZIP and installer are removed",
  { skip: !zipAvailable || !zipCli ? NO_ZIP_CLI : false },
  async () => {
    const bytes = await buildZip(PLUGIN);
    await withBox(fresh(bytes), async (box) => {
      const out = harnessOutput(box.run());
      assert.equal(out.active, true);
      assert.equal(out.options.novamira_ai_abilities_enabled, "1");
      assert.deepEqual(await box.status(), {
        ok: true,
        version: "1.12.8",
        aiEnabled: true,
      });
      assert.equal(
        await readFile(
          join(box.content, "plugins/novamira/novamira.php"),
          "utf8",
        ),
        "<?php /* real plugin */",
      );
      assert.equal(
        await readFile(
          join(box.content, "plugins/novamira/includes/loader.php"),
          "utf8",
        ),
        "<?php /* loader */",
      );
      assert.equal(existsSync(box.file), false);
      assert.equal(existsSync(join(box.content, SLUG, "novamira.zip")), false);
      assert.equal(existsSync(join(box.content, SLUG, "payload")), false);
      assert.deepEqual((await readdir(join(box.content, SLUG))).sort(), [
        "lock",
        "status.json",
      ]);
    });
  },
);

test(
  "an archive whose digest does not match installs nothing",
  { skip: !zipAvailable || !zipCli ? NO_ZIP_CLI : false },
  async () => {
    const bytes = await buildZip(PLUGIN);
    await withBox(
      fresh(bytes, { digest: sha256(Buffer.from("something else")) }),
      async (box) => {
        const out = harnessOutput(box.run());
        assert.equal(out.active, false);
        // PHP encodes an empty options array as `[]`, so count the keys.
        assert.equal(Object.keys(out.options).length, 0);
        assert.deepEqual(await box.status(), { ok: false, error: "digest" });
        assert.equal(existsSync(join(box.content, "plugins/novamira")), false);
        assert.equal(existsSync(join(box.content, SLUG, "payload")), false);
        assert.equal(
          existsSync(join(box.content, SLUG, "novamira.zip")),
          false,
        );
        assert.equal(existsSync(box.file), false);
      },
    );
  },
);

test(
  "an archive with an entry outside novamira/ is rejected before anything is extracted",
  { skip: !zipAvailable || !zipCli ? NO_ZIP_CLI : false },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "hq-cpanel-zip-"));
    try {
      const tree = join(work, "tree");
      await mkdir(join(tree, "novamira"), { recursive: true });
      await writeFile(join(tree, "novamira/novamira.php"), "<?php");
      await writeFile(join(tree, "stray.php"), "<?php");
      const zip = join(work, "novamira.zip");
      const run = spawnSync("zip", ["-qr", zip, "novamira", "stray.php"], {
        cwd: tree,
      });
      assert.equal(run.status, 0, String(run.stderr));
      const bytes = await readFile(zip);
      await withBox(fresh(bytes), async (box) => {
        harnessOutput(box.run());
        assert.deepEqual(await box.status(), { ok: false, error: "unsafe" });
        assert.equal(existsSync(join(box.content, "plugins/novamira")), false);
        assert.equal(existsSync(join(box.content, SLUG, "payload")), false);
        assert.equal(
          existsSync(join(box.content, SLUG, "novamira.zip")),
          false,
        );
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

test(
  "hostile entry names and symlink entries are refused before anything is extracted",
  { skip: !zipAvailable },
  async () => {
    // libzip reports a NUL inside a name as a space, so a NUL entry is shown
    // together with the traversal it would hide.
    for (const [label, entry, error] of [
      ["parent segment", { name: "novamira/../evil.php" }, "unsafe"],
      ["trailing parent", { name: "novamira/includes/.." }, "unsafe"],
      ["current segment", { name: "novamira/./evil.php" }, "unsafe"],
      ["backslash", { name: "novamira\\..\\evil.php" }, "unsafe"],
      ["backslash inside", { name: "novamira/a\\b.php" }, "unsafe"],
      ["NUL", { name: "novamira/a\0/../../evil.php" }, "unsafe"],
      [
        "symlink",
        { name: "novamira/link.php", body: "/etc/passwd", mode: 0o120777 },
        "link",
      ],
    ]) {
      const bytes = storedZip([
        { name: "novamira/novamira.php", body: "<?php" },
        entry,
      ]);
      await withBox(fresh(bytes), async (box) => {
        assert.equal(harnessOutput(box.run()).active, false, label);
        assert.deepEqual(await box.status(), { ok: false, error }, label);
        assert.equal(
          existsSync(join(box.content, "plugins/novamira")),
          false,
          label,
        );
        assert.equal(
          existsSync(join(box.content, SLUG, "payload")),
          false,
          label,
        );
        assert.equal(existsSync(join(box.content, "evil.php")), false, label);
        assert.equal(existsSync(box.file), false, label);
      });
    }
  },
);

test(
  "an extraction that leaves a file missing or short activates nothing and moves nothing",
  { skip: !zipAvailable },
  async () => {
    const bytes = storedZip(
      Object.entries(PLUGIN).map(([name, body]) => ({ name, body })),
    );
    for (const unzip of ["partial", "short"])
      await withBox(fresh(bytes, { unzip }), async (box) => {
        assert.equal(harnessOutput(box.run()).active, false, unzip);
        assert.deepEqual(
          await box.status(),
          { ok: false, error: "incomplete" },
          unzip,
        );
        assert.equal(
          existsSync(join(box.content, "plugins/novamira")),
          false,
          unzip,
        );
      });
  },
);

test(
  "an installer past its deadline after extraction never moves the plugin into place",
  { skip: !zipAvailable },
  async () => {
    const bytes = storedZip(
      Object.entries(PLUGIN).map(([name, body]) => ({ name, body })),
    );
    await withBox(
      fresh(bytes, { ttl: 60, age: 59, unzip: "slow" }),
      async (box) => {
        assert.equal(harnessOutput(box.run()).active, false);
        assert.deepEqual(await box.status(), {
          ok: false,
          error: "incomplete",
        });
        assert.equal(existsSync(join(box.content, "plugins/novamira")), false);
      },
    );
  },
);

test(
  "a plugin folder that is not whole after the move is moved back and nothing is activated",
  { skip: !zipAvailable },
  async () => {
    const bytes = storedZip(
      Object.entries(PLUGIN).map(([name, body]) => ({ name, body })),
    );
    await withBox(fresh(bytes, { vanish: true }), async (box) => {
      assert.equal(harnessOutput(box.run()).active, false);
      assert.deepEqual(await box.status(), { ok: false, error: "incomplete" });
      assert.equal(existsSync(join(box.content, "plugins/novamira")), false);
      assert.equal(
        existsSync(
          join(box.content, SLUG, "payload/novamira/includes/loader.php"),
        ),
        true,
      );
    });
  },
);
