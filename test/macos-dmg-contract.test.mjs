// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");
test("DMG contains an untouched application and Applications shortcut with Finder layout", async () => {
  const script = await source("scripts/macos-dmg.sh");
  assert.match(script, /ditto "\$app" "\$work\/source\/Novamira HQ.app"/);
  assert.match(script, /ln -s \/Applications/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /hdiutil detach/);
  assert.match(script, /-format UDZO/);
  assert.match(script, /hdiutil verify/);
  assert.match(script, /Refusing to overwrite/);
  const layout = await source("scripts/macos/dmg-layout.applescript");
  assert.match(layout, /background picture/);
  assert.match(layout, /Novamira HQ.app.*190, 290/);
  assert.match(layout, /Applications.*530, 290/);
  assert.match(layout, /icon size of viewOptions to 128/);
  const background = await source("scripts/macos/dmg-background.swift");
  assert.match(background, /novamira-hq-logo\.svg/);
  assert.match(background, /pixelsWide: 1440/);
  assert.match(
    await source("scripts/macos/novamira-hq-logo.svg"),
    /viewBox="0 0 87.64 8.83"/,
  );
  assert.match(
    await source("scripts/macos/dmg-background.swift"),
    /Drag Novamira HQ to Applications/,
  );
});
test("DMG is assembled after app stapling and separately signed, notarized and stapled", async () => {
  const signer = await source("scripts/macos-sign.sh");
  assert.ok(
    signer.indexOf('stapler staple "$app"') <
      signer.indexOf('bash "$root/scripts/macos-dmg.sh"'),
  );
  assert.match(signer, /codesign --timestamp .*"\$binary.dmg"/);
  assert.match(signer, /notary submit "\$binary.dmg" --wait/);
  assert.match(signer, /stapler staple "\$binary.dmg"/);
  assert.match(signer, /stapler validate "\$binary.dmg"/);
  assert.match(signer, /spctl --assess --type open/);
  for (const workflow of ["release.yml", "macos-signing.yml"]) {
    assert.match(
      await source(`.github/workflows/${workflow}`),
      /dist-desktop\/\$\{\{ matrix.asset \}\}\.dmg/,
    );
  }
});
test("Apple ticket checks and hdiutil steps are retried before a release fails", async () => {
  const signer = await source("scripts/macos-sign.sh");
  for (const step of [
    'retry xcrun stapler staple "$app"',
    'retry xcrun stapler validate "$app"',
    'retry xcrun stapler staple "$helper"',
    'retry xcrun stapler validate "$helper"',
    'retry spctl --assess --type execute -vv "$app"',
    'retry xcrun stapler staple "$binary.dmg"',
    'retry xcrun stapler validate "$binary.dmg"',
    "retry spctl --assess --type open",
  ])
    assert.ok(signer.includes(step), step);
  // A notarization submission is not retried: a repeat would be a new one.
  assert.doesNotMatch(signer, /retry notary submit/);
  const dmg = await source("scripts/macos-dmg.sh");
  for (const step of [
    "retry create_image",
    "retry hdiutil attach",
    'retry hdiutil detach -quiet "$work/mount"',
    "retry convert_image",
    'retry hdiutil verify "$output"',
  ])
    assert.ok(dmg.includes(step), step);
  assert.match(dmg, /create_image\(\) \{\n  rm -f "\$work\/writable\.dmg"/);
  assert.match(
    dmg,
    /\|\|\n  \{ sync; hdiutil detach -quiet -force "\$work\/mount"; \}/,
  );
  assert.match(dmg, /convert_image\(\) \{\n  rm -f "\$output"/);
});
