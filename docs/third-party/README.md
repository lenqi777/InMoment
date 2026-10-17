# Supplemental third-party license records

Prepared on 2026-10-17 for InMoment 0.10.0. Files in this directory supplement notices omitted from some npm package archives. Complete upstream license/notices are preserved without translation. They retain their own terms and are not relicensed under the InMoment MIT license.

The dependency-updated current package uses **sharp 0.35.5 / libvips 8.18.7** and its version-specific evidence is in [sharp-0.35.5](sharp-0.35.5/PROVENANCE.json). Root-level `SHARP-v0.34.5-*`, `SHARP-WINDOWS-v0.34.5-*`, `SHARP-LIBVIPS-v1.2.4-*`, `LIBVIPS-v8.17.3-*`, `image-libraries/` and `lgpl-library-notices/` preserve the **historical 0.34.5 / 8.17.3** evidence. They are not the current dependency inventory. SDL2 2.28.5 is also a historical-only notice; current ASR packaging excludes it.

`PROVENANCE.json` records source URLs, fixed revisions, file sizes and SHA-256 digests. The portable package should retain this directory together with the root `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_SOURCE_OFFER.md`.

| Files | Source and scope |
| --- | --- |
| `ONNXRUNTIME-v1.21.0-*` | MIT and complete ThirdPartyNotices from Microsoft's fixed v1.21.0 source; supplements Node/Common 1.21.0 |
| `ONNXRUNTIME-89f8206ba4-*` | MIT and complete ThirdPartyNotices from the source commit recorded inside the Web/Common dev packages |
| `SHARP-v0.34.5-LICENSE.txt` | Exact original Apache-2.0 text copied from the installed Windows x64 package |
| `SHARP-WINDOWS-v0.34.5-README.md` and `*-versions.json` | Original Windows package attribution, dependency license choices and recorded component versions |
| `SHARP-LIBVIPS-v1.2.4-*` | Complete Apache license and third-party notices from the fixed upstream packaging revision |
| `LIBVIPS-v8.17.3-LICENSE.txt` | Original libvips LGPL-2.1 text; the binary supplier's notice describes use of the later-version clause |
| `LGPL-3.0.txt` and `GPL-3.0.txt` | Complete standard license texts; SPDX's LGPL text also incorporates the GPL text |
| `ISC-standard-SPDX.txt` | Complete standard ISC reference, with the standard's placeholders preserved; it is not an author-specific recovered notice |

Upstream ONNX notices are supplied in full because an npm metadata license field alone omits their component notices. The complete upstream notice can describe optional components beyond a particular Windows build; inclusion of a notice is not a claim that every described component ships in InMoment.

## guid-typescript attribution gap

The installed and [published npm metadata for guid-typescript 1.0.9](https://registry.npmjs.org/guid-typescript/1.0.9) declare `ISC` and author `nicolas`. The installed npm archive contains `dist/`, `package.json` and `README.md`, with no standalone license/copyright notice. Its original repository URL redirects to [snico-dev/guid-typescript](https://github.com/snico-dev/guid-typescript), whose inspected current tree also has no license/notice file. The registry's `gitHead` is `1870de806c3db7ba46c5b8a1387c60fc9dda9284`; that object could not be retrieved from the current repository during preparation.

The original metadata is retained with the runtime. The standard ISC text is provided with clear provenance, preserving its placeholders instead of inventing a date, copyright holder or publisher permission. This documents a remaining attribution uncertainty; it is not a finding that the original notice was recovered. A future publisher can seek the author-specific notice or review the dependency path before final distribution. No author has been contacted by this preparation.

For source archives, patch sources, verification limits and library replacement, read [THIRD_PARTY_SOURCE_OFFER.md](../../THIRD_PARTY_SOURCE_OFFER.md).
