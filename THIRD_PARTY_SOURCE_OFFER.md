# Third-party source locations and library replacement

Prepared for InMoment 0.10.0 on 2026-10-17. This file identifies upstream source, the source collection prepared alongside the portable package, and how the LGPL-covered Windows libraries can be replaced. It does not make a three-year written source offer or claim that all legal obligations have been independently certified. The original license texts govern.

## What the application includes

The current release preparation production tree contains `sharp` 0.35.5 and `@img/sharp-win32-x64` 0.35.5. The latter declares `Apache-2.0 AND LGPL-3.0-or-later` and contains these separate Windows x64 files:

```text
resources/app/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node
resources/app/node_modules/@img/sharp-win32-x64/lib/libvips-cpp-8.18.7.dll
resources/app/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll
```

Use `resources/app/RUNTIME-DEPENDENCIES.json` to confirm the actual module location in a particular portable build. The complete package's original [version inventory](docs/third-party/sharp-0.35.5/SHARP-WINDOWS-v0.35.5-versions.json) and [licensing notice](docs/third-party/sharp-0.35.5/SHARP-WINDOWS-v0.35.5-README.md) are retained. The libvips DLL combines several libraries internally; replacing only an individual internal component requires rebuilding the libvips DLL and possibly its C++ wrapper.

InMoment does not modify these upstream JavaScript packages or DLL bytes. The upstream Windows builds do apply their own documented patches; those patches are present in the collected build-source archive. “Unmodified by InMoment” does not mean the upstream binary was built from unpatched source.

## Fixed upstream source and build recipes

| Component or recipe | Fixed source |
| --- | --- |
| sharp and Windows addon build rules | [sharp v0.35.5, commit 51a990faa26ade5586a4934ac9673c98d8893326](https://github.com/lovell/sharp/tree/51a990faa26ade5586a4934ac9673c98d8893326), including [src/binding.gyp](https://github.com/lovell/sharp/blob/v0.35.5/src/binding.gyp) |
| libvips packaging used by sharp | [sharp-libvips v1.3.4, commit ebb95f8add54eee8bed840e3fb587e4cbec857d7](https://github.com/lovell/sharp-libvips/tree/ebb95f8add54eee8bed840e3fb587e4cbec857d7) |
| Windows libvips build, dependency versions and patches | [build-win64-mxe v8.18.7, commit ef19ca09af2453d127453d677c849ccb37cf5694](https://github.com/libvips/build-win64-mxe/tree/ef19ca09af2453d127453d677c849ccb37cf5694) |
| MXE branch named by that build | [llvm-mingw-20260924](https://github.com/kleisauke/mxe/tree/llvm-mingw-20260924), source snapshot `c36160b231e66e1cbe032ed54aef7617e8b259da` retrieved during this preparation |
| LGPL license texts | [LGPLv3](docs/third-party/LGPL-3.0.txt), [GPLv3](docs/third-party/GPL-3.0.txt), [original libvips LGPLv2.1](docs/third-party/sharp-0.35.5/LIBVIPS-v8.18.7-LICENSE.txt) |

The upstream `sharp-libvips/build/win.sh` selects the `vips-dev-x64-web-8.18.7-static.zip` release asset. The Windows build recipe always builds libvips itself as a shared DLL, while many dependencies are linked inside it. The sharp Windows build separately compiles the libvips C++ wrapper for the MSVC ABI.

The [current binary match record](docs/third-party/sharp-0.35.5/LIBVIPS-BINARY-MATCH.json) confirms that the installed `libvips-42.dll` and the DLL in that official release asset have the same SHA-256, `06dab07cc386748513337a31672b1d5269fbc770a14ff403080575665bf0813f`. The separate [historical binary record](docs/third-party/LIBVIPS-BINARY-MATCH.json) applies to 8.17.3. This verifies artifact identity; it is not a reproducible-build test.

The current LGPL components are libvips 8.18.7, fribidi 1.0.17, glib 2.90.0, libexif 0.6.26, libheif 1.23.5, librsvg 2.63.2, pango 1.58.2 and proxy-libintl 0.5. Their official source archives and fixed build-source archives are prepared in the third-party source collection under `sharp-0.35.5/`. That directory's `SOURCE-MANIFEST.json`, `LGPL-SOURCE-DOWNLOADS.json` and `SHA256SUMS.txt` record actual files, source URLs, recipe-hash matches and status; `REBUILD.md` explains the upstream entry points. Locked Rust source archives for librsvg and the Cairo source are included with their own recorded hashes.

The separate `sharp-0.34.5/` collection preserves earlier libvips 8.17.3 source support for the retained original local packages. It does not describe the current rebuilt package. The application version remains 0.10.0 during first-publication preparation; build hashes and the runtime dependency manifest distinguish the dependency-updated package from the original local 0.10.0 package.

The actual [third-party source collection](https://github.com/lenqi777/InMoment/releases/download/v0.10.0/InMoment-third-party-sources.zip) accompanies the [0.10.0 binary Release](https://github.com/lenqi777/InMoment/releases/tag/v0.10.0), together with `InMoment-third-party-notices.zip` and `SHA256SUMS-current.txt`. The [historical binary archive](https://github.com/lenqi777/InMoment/releases/tag/history-binaries) also supplies the source collection and notices with `SHA256SUMS-history.txt`; use its `sharp-0.34.5/` material for the retained historical binaries. A list of external URLs by itself must not be presented as delivery of a source archive. The MXE branch snapshot documents the branch retrieved now; it is not proof of a bit-for-bit historical compiler environment. Rebuilding and replacing the DLLs has not been tested in this preparation.

## Replacing the Windows libraries

1. Close InMoment and its helper processes. Work on a copy of the portable application directory and preserve the original DLLs for rollback.
2. Obtain or build Windows x64 replacements using the source and upstream patches above. Preserve the libvips ABI expected by the particular package and the required dependent exports. For an incompatible C++ or native addon ABI change, rebuild the matching wrapper/addon using sharp's upstream rules.
3. Replace the corresponding files in the module's `lib` directory. There is no InMoment-specific checksum gate, signature check or encrypted application archive preventing a local replacement of these files.
4. Verify the application with a separate test-data directory. A binary compatibility failure may prevent image processing or startup; restore the original files if needed. This preparation has not validated a custom replacement build.

The upstream sharp documentation says a globally installed libvips is unsupported on Windows; this procedure concerns the actual local DLLs used by the portable application. See [sharp installation guidance](https://sharp.pixelplumbing.com/install/). InMoment adds no restriction on modifying covered libraries or reverse engineering the library combination for debugging such modifications under the applicable LGPL terms. Keep the relevant copyright, license and source notices with a redistributed replacement.

## Other source and notice details

ONNX Runtime Node/Common 1.21.0 comes from [v1.21.0](https://github.com/microsoft/onnxruntime/tree/v1.21.0). Web/Common `1.22.0-dev.20250409-89f8206ba4` identifies [commit 89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0](https://github.com/microsoft/onnxruntime/tree/89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0). Original complete MIT license and ThirdPartyNotices files are supplied in `docs/third-party/` for both revisions.

`guid-typescript` 1.0.9 declares ISC in published npm metadata. No standalone author-specific license/copyright file was found in the installed package or inspected current upstream repository. The registry's published `gitHead` could not be resolved in the current upstream repository. The standard ISC reference remains labelled as a reference and must not be misrepresented as an authenticated recovered notice; see [the recorded gap](docs/third-party/README.md).

This source support preserves actual versions, available source, recipes and original notices for review. It does not promise a custom build will reproduce the existing binaries, fill unknown attribution with invented information, or substitute for the original license terms.
