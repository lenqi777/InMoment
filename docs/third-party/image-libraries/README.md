# Image library license evidence

This directory preserves upstream license and copyright documents for the 20 non-LGPL image dependencies identified in `@img/sharp-win32-x64` 0.34.5 (`versions.json` and its package `README.md`). The underlying libvips version is 8.17.3. Retrieval date: 2026-10-17.

`PROVENANCE.json` records every document's fixed-version source URL, original byte count and SHA-256. Original documents have not been edited. Some original source or README files are retained in full because upstream places an additional copyright or license notice there; these files are evidence and are never executed. The main documents for libarchive and libxml2 explicitly refer to additional source-file notices, which are included here. FreeType's BDF, PCF and bundled gzip notices are included as well.

## Credits to include with the distributed application

The following two sentences should appear in the application's distributed third-party notices:

> Portions of this software are copyright © 2025 The FreeType Project (https://freetype.org). All rights reserved.

> This software is based in part on the work of the Independent JPEG Group.

The FreeType credit follows the preferred wording in [`freetype/FTL.TXT`](freetype/FTL.TXT). The year 2025 is supported by the copyright statement in the original [FreeType 2.14.1 `README`](https://raw.githubusercontent.com/freetype/freetype/VER-2-14-1/README), retained at [`freetype/README`](freetype/README). The original FTL is at the [same fixed release's `docs/FTL.TXT`](https://raw.githubusercontent.com/freetype/freetype/VER-2-14-1/docs/FTL.TXT).

The IJG sentence is required by the upstream [mozjpeg license explanation at the exact bundled commit](https://raw.githubusercontent.com/mozilla/mozjpeg/08265790774cd0714832c9e675522acbe5581437/LICENSE.md), retained at [`mozjpeg/LICENSE.md`](mozjpeg/LICENSE.md). The associated original [IJG notice](https://raw.githubusercontent.com/mozilla/mozjpeg/08265790774cd0714832c9e675522acbe5581437/README.ijg) is retained at [`mozjpeg/README.ijg`](mozjpeg/README.ijg). Keep both documents with the distribution.

## Cairo corresponding source

Cairo is listed as MPL-2.0 in the Windows sharp package. The original Cairo 1.18.4 source includes its dual-license explanation (`cairo/COPYING`) and original MPL-1.1 text (`cairo/COPYING-MPL-1.1`); both are retained unchanged. MPL-1.1 section 6.2 contains the subsequent-version provision. The official [Mozilla MPL-2.0 plaintext](https://www.mozilla.org/media/MPL/2.0/index.txt) is retained as `cairo/MPL-2.0.txt`.

The full, unmodified upstream `cairo-1.18.4.tar.xz` source archive is included in the release handoff's `third-party-sources` directory. Its SHA-256 is `445ed8208a6e4823de1226a74ca319d3600e83f6369f99b14265006599c32ccb`, matching the fixed MXE `src/cairo.mk` recipe in the separately retained build-source archive. `PROVENANCE.json` records the original download URL, filename, expected and actual hashes, recipe archive and member path. Preserve the Cairo source archive and the build-recipe/patch archives alongside the published binary release; the handoff's source manifest provides their final release locations.

## Scope and verification limits

All 20 requested components have a fixed-version primary license document; no requested document download remains unresolved. The 36 downloaded/extracted documents were checked against their recorded local SHA-256 values. libimagequant is the **lovell BSD 2-Clause v2.4.1 fork** identified by the fixed Windows build recipe; this evidence does not describe the licensing of current upstream libimagequant.

This directory is a source-evidence collection, not a claim that every transitive implementation file has been individually audited. Top-level upstream documents may refer to individual-file notices. LGPL components, Rust crate source packages, build patches, Electron, Node.js and JavaScript package notices are handled by the release handoff's other third-party materials. Do not omit those materials when constructing the final release.
