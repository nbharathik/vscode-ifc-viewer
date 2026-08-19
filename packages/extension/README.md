# IFC Viewer for VS Code

Open `.ifc` building models in a real 3D viewer inside VS Code. Orbit the
model, browse the spatial tree, click to select elements, and read their
properties and property sets. Built for large files: parsing runs in a
worker, geometry streams in progressively, and rendering is GPU-batched.

![The IFC Viewer: spatial tree, 3D viewport, and properties panel](https://raw.githubusercontent.com/nbharathik/vscode-ifc-viewer/main/docs/images/viewer.png)

## Features

| Feature | Description |
| --- | --- |
| 3D viewport | Orbit, pan, zoom, fit-to-model, fit-to-element, and fit-to-selection. |
| Viewer toolbar | A compact icon toolbar beside the spatial tree: fit, standard views, visibility, section plane, and filters. |
| Standard views | Isometric, top, bottom, front, back, left, and right, plus a perspective/orthographic switch for plan and elevation inspection. |
| Section plane | Slice the model along the X, Y, or Z axis with a live slider and flip control, driven by GPU clipping with no geometry rebuilds. |
| Search | Search the spatial tree by name, type, express ID, or GlobalId; filter the properties panel locally. |
| Filters | Show only chosen IFC types and storeys. Filters combine predictably and reset with one action. |
| Large models | Worker parsing and progressive streaming keep the UI responsive; GPU instancing and frustum culling keep frame rates high. |
| Spatial tree | Project, Site, Building, Storey, and elements, expanded lazily. Click to select. |
| Selection | Click in 3D to highlight, reveal in the tree, and show properties. |
| Properties | Direct attributes plus every property set and quantity set with values. |
| Visibility | Hide, isolate, show all, per-node toggles, and toggles for spaces and openings. |
| Panels | Each panel collapses from its own header and comes back from a small edge button, so the model can fill the tab. |
| View persistence | The camera, panels, section, and filters survive tab switches and webview reloads. |
| Theme | Follows your VS Code light or dark theme. |
| Statistics | Entity counts by class, file size, and load phase timings. |
| Performance HUD | Press `P` for live render time, draw calls, and the load timeline. |
| Robust errors | Corrupt or oversized files show a readable in-view error card, never a blank tab. |

## Usage

Open any `.ifc` file and the IFC Viewer editor opens automatically.

| Input | Action |
| --- | --- |
| Left-drag | Orbit |
| Right-drag or middle-drag | Pan |
| Wheel | Zoom |
| `F` | Fit the model to the view |
| Double-click | Fit to the clicked element |
| `H` | Hide the selection |
| `I` | Isolate the selection |
| `A` | Show all |
| `P` | Toggle the performance HUD |
| `Esc` | Clear the selection |

The toolbar at the top left, next to the spatial tree, holds the everyday
tools: fit the model, choose a standard view or orthographic projection,
hide/isolate/show elements, enable the section plane, and open the type and
storey filters. Each panel collapses with the button in its own header and
returns from a small button on the viewport edge. The search box above the
spatial tree finds elements by name, type, ID, or GlobalId, and the
properties panel has its own local filter.

Commands: **IFC Viewer: Reset View**, **IFC Viewer: Show Statistics**,
**IFC Viewer: Toggle Spatial Tree**, and **IFC Viewer: Toggle Properties
Panel**.

## What it is not (yet)

The viewer is read-only. There is no editing, measurement, section caps or 2D
section drawing, BCF, multi-model federation, IFC5 or ifcx, or WebGPU
support yet. These are tracked for later releases.

## Credits and licenses

Extension code is licensed under MIT. Built on
[web-ifc](https://github.com/ThatOpen/engine_web-ifc) (MPL-2.0) and
[Three.js](https://threejs.org/) (MIT). 
