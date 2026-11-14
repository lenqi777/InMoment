# InMoment action icons

These assets come from [Microsoft Fluent UI System Icons 1.1.345](https://github.com/microsoft/fluentui-system-icons/tree/9eb184e96268d3293462f9d9d19225b4c7b07774), commit `9eb184e96268d3293462f9d9d19225b4c7b07774`, under the [MIT license](LICENSE.txt). The upstream [NOTICE](NOTICE.txt) is retained.

`manifest.json` maps each application semantic key to a separate Regular/Filled SVG pair. It records the exact source, SHA-256 digest, byte count, optical size and any modification. The selected icons use the upstream 20px optical drawings; the UI can display them at 16px or 20px.

The application loads these local files through `src/shared/ui-icons.js`. The `.ui-icon-outline` and `.ui-icon-solid` layers use separate Regular and Filled designs as masks. `src/shared/ui-controls.css` controls the transition between them.

## Single AI sparkle

Fluent's original Sparkle includes two stars. InMoment uses a single four-point star: the Regular and Filled files independently retain their original primary star and remove the smaller one. The path geometry stays unchanged; both views use `viewBox="2 2 12 12"` to center the retained star. `upstream/` contains the original SVGs, and the manifest describes the extraction.

## Application mappings

- `folder-in`: Folder Arrow Right, for adding to an existing group.
- `folder-plus`: Folder Add, for creating a group and adding the record.
- `focus`: Scan Object, for focusing the selected inspiration.
- `cloud`: Branch Fork, for the inspiration relationship view.
- `checklist`: Text Bullet List Square, for selecting or reviewing records.
- `group-fold` combines three rounded strokes with the respective Fluent chevron in each weight. The group column mirrors the glyph to indicate expansion when collapsed.
- `plus` and `link` preserve existing application keys as aliases for `add` and `cloud`.

The icons are bundled with the application. Loading or displaying an icon requires no network request.
