# Desktop license verification — 2026-09-28

This is an engineering evidence record, not a legal certification. The release check validates documented license materials and explicit unresolved obligations. An incomplete exhaustive source audit, a missing standalone LICENSE file, or an unavailable Git commit is not by itself a release blocker.

## Completed checks

- Identified the embedded x64 Microsoft WebView2 Loader as version 1.0.1150.38 by a byte-for-byte comparison with the official NuGet archive. The archive declares `LICENSE.txt`; its original BSD-3-Clause notice is now bundled. Manifest digests bind the notice to the loader pinned by the build.
- Verified all 51 initially missing registry archives against their recorded checksums. Recovered eight package records through exact-revision upstream notices or existing same-revision workspace evidence. Removed six source-code files that had been mistaken for notices, exposing two additional missing records. The resulting count is **45 registry packages without a collected standalone notice file**. These now have checksum-bound published declarations, bundled standard terms, published author credits and observed source attribution in `legal/runtime-license-evidence.json`.
- Expanded V8/native notice evidence from 17 to 33 entries, including ICU, Abseil, FP16, libc++, libc++abi, libunwind, fast_float, LLVM libc, simdutf, Highway and Dragonbox. This does not establish complete nested-source coverage. Chromium partition_alloc had no root notice in its standalone source repository.
- Resolved default-feature normal dependency graphs for all four release targets with Cargo 1.95.0: macOS ARM64 705 packages, macOS x86_64 707, Windows MSVC x86_64 740, Linux GNU x86_64 714. All resolved package identities exist in the conservative 900-package inventory. The union still includes 40 packages without collected notices. See `legal/runtime-targets.json`. Proc-macros and unified features may overstate binary inclusion; build dependencies and embedded native sources need separate analysis.

## Modified-runtime verification

The source-build/relinking path succeeded on macOS Apple Silicon with Deno 2.9.6, Rust 1.95.0, Rusty V8 150.4.0 and Xcode. A separate temporary workspace was used; installed registry source files were not edited.

The Deno upstream Cargo.lock SHA-256 is `6c6af74640994cc41fcc7f46bb5204a50da679adc2dee96cb05aa97867baf7e1`. The published V8 archive SHA-256 is `42a978ff11f15b24e5c05a7123cf2b68f41e763546699781a924ef4e2cf43a49`. The V8 package was copied to a private source tree and patched through `[patch.crates-io] v8 = { path = ... }`. The local verification patch is preserved in `verification/glibc-marker.patch`.

The published V8 crate omits required source-build inputs. For this test, `third_party/icu/common/icudtl.dat` was populated from the checksum-verified `deno_core_icudata@0.77.0` archive, and the complete Chromium Rust vendor submodule was obtained at commit `26e8ff47f18a8d28d6187a04b6a16cb7332356f8`. These inputs are part of the verification recipe; copying the V8 crate alone is insufficient. Prefer the complete recursive upstream checkout for the documented ordinary source-build path.

With the LLVM linker from the temporary Rust toolchain on PATH, the build ran:

```sh
V8_FROM_SOURCE=1 CARGO_BUILD_JOBS=4 cargo +1.95.0 build --release --manifest-path cli/rt/Cargo.toml --bin denort
DENORT_BIN=/path/to/rebuilt/denort bun run desktop:build
node scripts/desktop-smoke.mjs dist-desktop/novamira-hq-desktop
```

The rebuilt denort SHA-256 is `8e25f5a3ecf07fe6ba4275ab45aadf40e99386d729c4418735b1db6b09ef6793`. Both denort and HQ contained the exact bytes `HQ_LICENSE_REBUILD_20260928` from the modified glibc-derived C file. The native symbol `_hq_license_rebuild_marker` was also present in the experimental HQ executable and absent from the ordinary-runtime build; searching bundled documentation for the marker alone is not a sufficient check. The HQ smoke suite passed command registration/relocation, child-process management, registrar isolation, embedded site CLI and OAuth mocks, dashboard serving/shutdown and MCP initialization. No signed DMG, GUI, Intel, Windows or Linux source-rebuild acceptance is claimed. These experimental executables are not release artifacts.

## Published-declaration evidence

The 45 packages below are documented from their published, checksum-verified
Cargo.toml declarations: 32 select Apache-2.0 (including explicit alternatives),
12 select MIT and one selects CC0-1.0. No standalone file is invented or
required solely to duplicate a known standard license. The canonical terms are
bundled, along with copyright headers found in the archived source and author
credits declared by the publisher. Credits are not asserted to be copyright
ownership. MIT terms omit the SPDX template's placeholder copyright line;
original copyright headers are retained separately without inventing dates or
owners. The ICU data wrapper also references the retained native ICU notice.

SWC's unavailable VCS revisions remain a source-provenance observation, not a
contradictory license declaration: the published archive itself contains the
Apache-2.0 declaration. Source attribution from Rust-derived code in swc_common
is preserved with the standard terms.

| Package                                 | Declared license  |
| --------------------------------------- | ----------------- |
| `aead-gcm-stream@0.4.0`                 | MIT               |
| `ast_node@5.0.0`                        | Apache-2.0        |
| `better_scoped_tls@1.0.1`               | Apache-2.0        |
| `deno_core_icudata@0.77.0`              | MIT               |
| `deno_native_certs@0.3.0`               | MIT               |
| `deno_tunnel@0.8.1`                     | MIT               |
| `derive-io-macros@0.4.1`                | MIT OR Apache-2.0 |
| `derive-io@0.4.1`                       | MIT OR Apache-2.0 |
| `dlopen2@0.6.1`                         | MIT               |
| `fqdn@0.5.2`                            | MIT               |
| `from_variant@3.0.0`                    | Apache-2.0        |
| `hexf-parse@0.2.1`                      | CC0-1.0           |
| `rsqlite-vfs@0.1.1`                     | MIT               |
| `rustls-tokio-stream@0.8.0`             | MIT               |
| `sacabase@2.0.0`                        | MIT               |
| `sptr@0.3.2`                            | MIT OR Apache-2.0 |
| `string_enum@1.0.2`                     | Apache-2.0        |
| `swc_allocator@4.0.1`                   | Apache-2.0        |
| `swc_atoms@9.0.0`                       | Apache-2.0        |
| `swc_common@17.0.1`                     | Apache-2.0        |
| `swc_config_macro@1.0.1`                | Apache-2.0        |
| `swc_config@3.1.2`                      | Apache-2.0        |
| `swc_ecma_ast@18.0.0`                   | Apache-2.0        |
| `swc_ecma_codegen_macros@2.0.2`         | Apache-2.0        |
| `swc_ecma_codegen@20.0.2`               | Apache-2.0        |
| `swc_ecma_lexer@26.0.0`                 | Apache-2.0        |
| `swc_ecma_loader@17.0.0`                | Apache-2.0        |
| `swc_ecma_parser@27.0.7`                | Apache-2.0        |
| `swc_ecma_transforms_base@30.0.1`       | Apache-2.0        |
| `swc_ecma_transforms_classes@30.0.0`    | Apache-2.0        |
| `swc_ecma_transforms_macros@1.0.1`      | Apache-2.0        |
| `swc_ecma_transforms_proposal@30.0.0`   | Apache-2.0        |
| `swc_ecma_transforms_react@33.0.0`      | Apache-2.0        |
| `swc_ecma_transforms_typescript@33.0.0` | Apache-2.0        |
| `swc_ecma_utils@24.0.0`                 | Apache-2.0        |
| `swc_ecma_visit@18.0.1`                 | Apache-2.0        |
| `swc_eq_ignore_macros@1.0.1`            | Apache-2.0        |
| `swc_macros_common@1.0.1`               | Apache-2.0        |
| `swc_ts_fast_strip@36.0.0`              | Apache-2.0        |
| `swc_visit@2.0.1`                       | Apache-2.0        |
| `sys_traits_macros@0.1.0`               | MIT               |
| `sys_traits@0.1.28`                     | MIT               |
| `valuable@0.1.0`                        | MIT               |
| `winapi-i686-pc-windows-gnu@0.4.0`      | MIT/Apache-2.0    |
| `winapi-x86_64-pc-windows-gnu@0.4.0`    | MIT/Apache-2.0    |

## Release check policy and maintenance

The check fails for changed dependency/asset pins, missing or altered retained
texts, missing published-declaration evidence, a changed archive/declaration,
an unreviewed license expression, a selection not permitted by the recorded
expression, missing supplementary notices, or a concrete issue recorded in
`desktopReview.blockers`. Historical source-audit `status` flags do not decide
whether these materials are present. Passing is not a legal certification.

Existing upstream notices are retained unchanged. Canonical license copies and
declaration evidence supplement them; they do not replace known package-specific
attribution or override contradictory terms. A new conflict must be recorded as
a blocker until resolved. The check runs offline and does not fetch license texts
during a build.

Reuse this evidence while the dependency locks and bundled artifacts remain
unchanged. Review changed components when those inputs change. Do not require a
new exhaustive runtime audit or source rebuild for every HQ release.

The distributor must continue to maintain the source offer and provide matching
source/build materials. The successful macOS source-rebuild test supports that
process; it is not a substitute for retaining the materials. Signed installer
acceptance remains part of the ordinary release procedure.
