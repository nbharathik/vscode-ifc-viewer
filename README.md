# IFC Viewer for VS Code

Open and explore IFC building models directly in Visual Studio Code. IFC Viewer
provides a fast, read-only workspace for navigating model structure, inspecting
elements, and reviewing properties.

<p align="center">
  <img src="docs/images/viewer.png" width="80%" alt="IFC Viewer with a spatial tree, 3D viewport, and properties panel" />
</p>

## Features

- Interactive 3D navigation with standard views and an axis-aligned section plane.
- Spatial tree with synchronized model selection and property inspection.
- Search, filtering, and visibility controls for elements, types, and storeys.
- Progressive loading and GPU-optimized rendering for large models.
- Theme-aware interface with persistent camera and panel state.

## Installation

Install **IFC Viewer** from the Visual Studio Marketplace, or run:

```sh
code --install-extension BharathikannanN.vscode-ifc-viewer
```

The extension requires Visual Studio Code 1.96 or later.

## Usage

Open any `.ifc` file and the viewer starts automatically.

- Left-drag to orbit, right- or middle-drag to pan, and scroll to zoom.
- Select an element to reveal it in the spatial tree and inspect its properties.
- Press `F` to fit the model, `H` to hide, `I` to isolate, `A` to show all, and
  `Esc` to clear the selection.

## Development

Node.js 20 or later is required.

```sh
npm install
npm run typecheck
npm run lint
npm run package
```

Press `F5` in VS Code to launch the Extension Development Host. See
[CONTRIBUTING.md](CONTRIBUTING.md) for project details and contribution
guidelines.

## License

This project is licensed under the [MIT License](LICENSE). It uses
[web-ifc](https://github.com/ThatOpen/engine_web-ifc) under MPL-2.0 and
[Three.js](https://threejs.org/) under MIT.
