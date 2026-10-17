# Image library license evidence — sharp 0.35.5

This directory preserves fixed-version upstream license and copyright documents for the 20 explicitly versioned non-LGPL image dependencies identified in the official `@img/sharp-win32-x64` 0.35.5 package (`versions.json` and `README.md`), plus the embedded libnsgif implementation listed in its README. The underlying libvips version is 8.18.7. Retrieval date: 2026-10-17. Older sharp 0.34.5 evidence is preserved separately and has not been substituted for changed component versions.

`PROVENANCE.json` records every document's fixed-version source URL, original byte count and SHA-256. Original documents have not been edited. Documents from the same upstream version and URL may be ordinary file copies of previously verified evidence; these entries retain the identical hash and explicitly record `reusedFrom`. Some original source or README files are retained in full because upstream places an additional copyright or license notice there. They are evidence and are never executed.

## Credits to include with the distributed application

The following two sentences should appear in the application's distributed third-party notices:

> Portions of this software are copyright © 2026 The FreeType Project (https://freetype.org). All rights reserved.

> This software is based in part on the work of the Independent JPEG Group.

The FreeType credit follows the preferred wording in [`freetype/FTL.TXT`](freetype/FTL.TXT). The year 2026 is supported by the copyright statement in the original [FreeType 2.14.3 `README`](https://raw.githubusercontent.com/freetype/freetype/VER-2-14-3/README), retained at [`freetype/README`](freetype/README). The original FTL is at the [same fixed release's `docs/FTL.TXT`](https://raw.githubusercontent.com/freetype/freetype/VER-2-14-3/docs/FTL.TXT). FreeType's BDF, PCF and bundled gzip notices are also retained.

The IJG sentence is specified by the upstream [mozjpeg license explanation at the exact bundled commit](https://raw.githubusercontent.com/mozilla/mozjpeg/08265790774cd0714832c9e675522acbe5581437/LICENSE.md), retained at [`mozjpeg/LICENSE.md`](mozjpeg/LICENSE.md). Its associated original [IJG notice](https://raw.githubusercontent.com/mozilla/mozjpeg/08265790774cd0714832c9e675522acbe5581437/README.ijg) is retained at [`mozjpeg/README.ijg`](mozjpeg/README.ijg). Keep both documents with the distribution.

## Cairo corresponding source

The Windows sharp package identifies Cairo 1.18.6 as MPL-1.1. The original source distribution's dual-license explanation (`cairo/COPYING`) and MPL-1.1 text (`cairo/COPYING-MPL-1.1`) are retained unchanged. The original source describes Cairo library implementation files as available under LGPL-2.1 or MPL-1.1; the MPL-1.1 path matches the package notice. Auxiliary source directories may carry other licenses and remain intact within the full source archive.

The full, unmodified upstream `cairo-1.18.6.tar.xz` source archive is included in the release handoff's `third-party-sources/sharp-0.35.5` directory. Its expected SHA-256 is `1c767308174337a74694da0f3ec069c271452163a1ef4540964c50c301f157d4`, as recorded by the fixed `build/overrides.mk` in `libvips-build-win64-mxe-ef19ca09af2453d127453d677c849ccb37cf5694.tar.gz`. `PROVENANCE.json` is written only after the downloaded archive matches that hash; it records the actual hash, size, URL, filename and recipe location. Preserve this source archive and the associated build-recipe/patch archives with the published binary release; the handoff's source manifest gives their final release locations.

## Version-specific notes

- `libimagequant` is the lovell BSD 2-Clause v2.4.1 fork, matching the Windows build recipe; its license evidence does not describe the licensing of current upstream libimagequant.
- Highway 1.4.0 consolidates Apache-2.0, BSD-3-Clause and CC0 text in its original `LICENSE`. The package README identifies the BSD-3-Clause path; the complete upstream document is preserved. A separate `LICENSE-BSD3` was not present at the attempted fixed release URL.
- libultrahdr 2.0.2 is newly listed in this sharp build. Its upstream original `LICENSE` includes MIT and Apache-2.0 text, both preserved. A separate root `NOTICE` was not present at the attempted fixed release URL. No notice file has been fabricated.
- libspng is absent from the new package's version inventory and is not carried forward from the old evidence directory.
- libnsgif has no independent version in the package inventory. Its MIT `COPYING` and build file are preserved from the exact libvips `v8.18.7` source; its evidence version is `embedded in libvips 8.18.7`. The build file adds the `nsgif` static library to `libvips_components`. No separate library version has been inferred.
- libarchive and libxml2 top-level documents refer to additional source-file copyright notices; the specifically referenced compression, dictionary and list implementation notices are retained in full here.

## Verification limits

Each requested component has a primary fixed-version upstream license document. Optional missing upstream filenames are recorded separately in `PROVENANCE.json`; the existing consolidated originals contain the relevant text. Source evidence is not a claim that every transitive implementation file has been individually audited. LGPL components, Rust crate sources, build patches, Electron, Node.js and JavaScript package notices are handled by the handoff's other third-party materials. Preserve all of those materials when constructing the final release.
