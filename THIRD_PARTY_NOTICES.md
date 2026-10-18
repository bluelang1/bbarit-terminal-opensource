# Third-party notices

The existing root MIT license applies to original BBARIT Terminal code. Imported components keep their own copyrights and licenses. `THIRD_PARTY.md` retains the existing brew-browser attribution and MIT permission text.

## Included source and resources

| Component | Source and preserved notices |
| --- | --- |
| Semble Rust port in `bbarit-agent/vendor/semble/` and `src-tauri/src/semble/` | The embedded port identifies [johunsang/semble_rs](https://github.com/johunsang/semble_rs) and MIT in its Cargo manifest. Its README credits the [MinishLab Semble](https://github.com/MinishLab/semble) implementation. The existing host MIT grant is also copied to the vendored crate; the upstream MinishLab MIT notice is preserved in `licenses/MinishLab-semble-MIT.txt`. The unused duplicate crate under `src-tauri/vendor/` is excluded from the clean source distribution. |
| Persona library | Existing MIT notice at `bbarit-agent/personas/LICENSE` (AgentLand Contributors), including its existing upstream attribution. |
| Design-gallery skills | Existing Meng To MIT notice at `bbarit-agent/skills/design-gallery/LICENSE`. The imported source records MengTo/Skills revision `25f872a`; a pinned upstream license copy is also retained in `licenses/MengTo-Skills-MIT.txt`. One skill references an `upstream-license.md` file absent from that upstream snapshot; no separate missing notice has been invented. |
| Bundled SEO/GEO skills | Existing Apache-2.0 licenses at `src-tauri/resources/claude-skills/LICENSE` and `src/seo-skills/LICENSE`, with original authorship metadata in the skill files. Preserve this notice when redistributing or installing these resources. |
| Imported skill bodies in `src/skills/openJarvisSkills.ts` | Root MIT notices for Hermes and OpenClaw, Apache-2.0 for OpenJarvis, and the separate Hermes humanizer/powerpoint MIT notices are retained under `licenses/`. Source URLs remain in the catalog. The original import revisions were not recorded; the pinned license evidence does not assert byte-for-byte equivalence with the historical imported bodies. |
| Public skill-catalog metadata | The catalog preserves upstream URLs and descriptions. A catalog listing does not relicense the linked material. Retain the source links and review the upstream terms before importing additional full skill bodies. |

`licenses/PROVENANCE.json` records source URLs, revisions where available, and SHA-256 hashes for the added permission texts. Existing nested notices remain with their source trees.

## Bundled fonts

The nine WOFF2 files retain their embedded notices. Independent permission texts and copies of the exact embedded metadata are included under `licenses/`:

| Family | Notice |
| --- | --- |
| Fira Code | `FiraCode-OFL.txt` (SIL OFL) |
| JetBrains Mono | `JetBrainsMono-OFL.txt` (SIL OFL) |
| D2Coding | `D2Coding-OFL.txt` and `D2Coding-NOTICE.md` |
| Hack | `Hack-LICENSE.txt` (MIT and Bitstream Vera terms) |
| Cascadia Code | `CascadiaCode-LICENSE.txt` (Microsoft's modified OFL text) |

Honor each font's reserved names and modification conditions. Fontsource packages installed through npm provide their own license notices.

## Separately installed dependencies and binary distributions

Use `package-lock.json`, `src-tauri/Cargo.lock`, and `bbarit-agent/Cargo.lock` to identify exact dependencies. Their licenses do not become MIT because this project's own code is MIT. In particular, the resolved SurrealDB 2.6.2 dependency uses Business Source License terms (`licenses/SurrealDB-2.6.2-BSL.txt`); it is not an OSI open-source license. Consult the license for the exact resolved version before offering a service or redistributing a compiled product using it.

This clean source distribution excludes prebuilt executables, private release/signing material, user projects and captures. Before distributing a compiled installer, collect the license/notice files for the actual dependency tree and bundled binaries, and verify the terms of optional services and downloaded tools. Brand artwork provenance is maintained separately from third-party software licensing; project trademarks and external service rights are not granted by a dependency license.
