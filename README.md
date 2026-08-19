# IFC Viewer for VS Code

Open `.ifc` building models in a real 3D viewer inside VS Code. Orbit the
model, browse the spatial tree, click to select elements, and read their
properties. Built for large files: parsing runs in a worker, geometry streams
in progressively, and rendering is GPU-batched.

<p align="center">
  <img src="docs/images/viewer.png" width="80%" alt="The IFC Viewer: spatial tree, 3D viewport, and properties panel" />
</p>

## Features

- **3D viewport**: orbit, pan, zoom, fit-to-model, fit-to-element, and
  fit-to-selection.
- **Viewer toolbar**: a compact icon toolbar beside the spatial tree with
  fit, standard views, visibility, section plane, and filters.
- **Standard views**: isometric, top, bottom, front, back, left, and right,
  plus a perspective/orthographic switch for plan and elevation inspection.
- **Section plane**: slice the model along the X, Y, or Z axis with a live
  slider and a flip control. GPU clipping only; geometry is never rebuilt,
  and clipped elements cannot be picked through the cut.
- **Search**: find elements in the spatial tree by name, type, express ID, or
  GlobalId, with ancestors revealed; filter the properties panel locally.
- **Filters**: show only chosen IFC types and storeys. Groups combine with
  AND, values within a group with OR, and one action resets them.
- **Large models**: worker parsing, progressive streaming, GPU instancing, and
  frustum culling. The UI never freezes and the first geometry appears within
  seconds.
- **Spatial tree**: Project, Site, Building, Storey, and elements, expanded
  lazily.
- **Selection**: click in 3D to highlight, reveal in the tree, and show
  properties.
- **Properties**: direct attributes plus every property set and quantity set
  with values.
- **Visibility**: hide, isolate, or show all, with per-node toggles and
  toggles for spaces and openings. Isolate a single storey to inspect it
  on its own.
- **Panels**: the spatial tree and the properties panel collapse
  independently from their own headers, so the model can take the full width
  of the tab; a small edge button brings each one back.
- **View persistence**: the camera, panels, section, and filters survive tab
  switches and webview reloads.
- **Theme**: the viewport and panels follow your VS Code light or dark theme.
- **Statistics**: entity counts by class, file size, and load phase timings.
- **Performance HUD**: press `P` for live render time, draw calls, and the
  load timeline.
- **Robust errors**: corrupt or oversized files show a readable in-view error
  card, never a blank tab.

The viewer is read-only. Editing, measurements, section caps and 2D section
drawings, BCF, multi-model federation, IFC5, and WebGPU are out of scope for
now and tracked for later releases.

## Install

From the Visual Studio Marketplace: search for "IFC Viewer", or run
`code --install-extension BharathikannanN.vscode-ifc-viewer`. You can also
install a packaged build directly with
`code --install-extension vscode-ifc-viewer-1.1.0.vsix`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, project layout, and the
checks every change has to keep green. In short:

```sh
npm install
npm run typecheck
npm run lint
npm run package -w packages/extension
```

Contributors can press `F5` in VS Code to launch the extension in an
Extension Development Host, or run `npm run harness:serve` for a plain
browser page with the same viewer.

## Usage

Open any `.ifc` file and the viewer starts automatically. The layout is a
spatial tree on the left, the 3D viewport in the middle, and a properties
panel on the right.

**Navigate the model**

- Left-drag to orbit, right-drag or middle-drag to pan, wheel to zoom.
- Press `F` to fit the whole model, or double-click an element to fit to it.
- The Views menu in the toolbar offers fit-to-selection, the standard views
  (isometric, top, bottom, front, back, left, right), an orthographic
  projection switch, and reset.

**Inspect elements**

- Click an element in 3D to select it: it highlights, the tree reveals it,
  and the properties panel shows its attributes, property sets, and
  quantities. Press `Esc` to clear the selection.
- Or browse the tree directly; selecting a node highlights it in 3D.
- Search the tree by name, type, express ID, or GlobalId; matches are
  highlighted with their ancestors revealed, and Enter selects the first
  match. The properties panel has its own local filter box.

**Control visibility**

- With a selection: `H` hides it, `I` isolates it, `A` shows everything
  again. The same actions live in the toolbar's visibility menu, next to the
  toggles for spaces and openings. Each tree node also has its own toggle.
- The filter menu limits the view to chosen IFC types and storeys without
  touching manually hidden elements; Reset filters brings everything back.

**Slice the building**

- The section menu enables one axis-aligned section plane. Pick the X, Y, or
  Z axis, drag the slider to move the cut through the model, flip the kept
  side, or reset it. Clipped geometry is not pickable through the cut.

**See more of the model**

- Each panel header carries its own collapse button, right-aligned beside the
  title. A collapsed panel leaves a small button on its edge of the viewport
  that brings it back. Your selection and camera are kept, and the toolbar
  follows the tree edge so it never covers anything.

**Diagnostics**

- Press `P` for the performance HUD (render time, draw calls, load timeline).
- Command Palette: **IFC Viewer: Reset View**, **IFC Viewer: Show
  Statistics**, **IFC Viewer: Toggle Spatial Tree**, and **IFC Viewer:
  Toggle Properties Panel**.

## Credits and licenses

- Extension code is licensed under the [MIT License](LICENSE).
- [web-ifc](https://github.com/ThatOpen/engine_web-ifc) is licensed under MPL-2.0.
- [Three.js](https://threejs.org/) is licensed under MIT.
