# Contributing

Thanks for your interest in improving the IFC Viewer. This document covers local
setup, the test gate, and the conventions the project follows.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Python 3.10 or newer with `ifcopenshell`, only if you need to regenerate the
  IFC fixtures

## Setup

```sh
npm install
npx playwright install chromium
```

This installs the workspace dependencies and the headless Chromium build that
the visual tests render into.

## Running the extension

Press `F5` in VS Code (the "Run IFC Viewer Extension" launch config) to build the
bundles and open a second window with the extension loaded, then open any `.ifc`
file. See `packages/extension` for the extension host and webview code.

## Project layout

This is an npm-workspaces monorepo with two packages:

- `packages/viewer-core` is the framework-agnostic viewer library. It renders in
  any browser page and never imports `vscode`.
- `packages/extension` is the VS Code extension: a custom editor and a webview
  that loads the bundled viewer. It never imports `three` or `web-ifc`.

All IFC access goes through a single engine adapter in
`packages/viewer-core/src/engine/`, the only place `web-ifc` is imported.

## The test gate

Every change must keep the following green before it is committed:

```sh
npm run typecheck   # tsc strict, all TypeScript projects
npm run lint        # eslint (flat config)
npm test            # vitest (Node): engine, tree, and property logic
npm run test:e2e    # Playwright (headless WebGL): render and interaction
npm run test:ext -w packages/extension    # @vscode/test-electron
npm run package -w packages/extension     # vsce package
```

The same gate runs in CI on `ubuntu-latest` under `xvfb`.

Notes:

- `npm run test:ext` launches a real VS Code instance. On CI it uses the stable
  build under `xvfb`. On a developer machine where a system VS Code update is in
  progress, set `VSCODE_VERSION=insiders` to use a separate build.
- Playwright pixel baselines are platform-specific because SwiftShader rasterizes
  differently per OS. They are committed with a platform suffix (for example
  `...-win32.png`). Regenerate them for your platform only when a visual change
  is intended: `npm run test:e2e -- --update-snapshots`, then commit the PNGs.

## Conventions

- **Layer boundaries are enforced by tests.** `packages/extension` must not
  import `three` or `web-ifc`, and `packages/viewer-core` must not import
  `vscode`. The checks live in `tests/architecture.test.ts`. Do not remove or
  weaken them.
- **All engine access goes through the adapter** in
  `packages/viewer-core/src/engine/`. Nothing else may import `web-ifc`.
- **Structural assertions come first.** Visual snapshots exist as a secondary
  signal. A test should assert mesh counts, triangle counts, bounds, or DOM text
  so a snapshot difference is never the only thing that fails. Do not loosen a
  structural assertion to make a test pass.
- **Regenerate snapshots only for intentional visual changes,** and say so in the
  commit message.
- **Fixtures are generated, not downloaded.** Regenerate them with
  `npm run fixtures` (Python + `ifcopenshell`).

## Commits and pull requests

- Keep commits focused and write a clear subject line.
- Make sure the full gate is green.
- Describe user-visible changes in [CHANGELOG.md](CHANGELOG.md) under an
  Unreleased heading.

## Scope

The viewer is deliberately read-only. Editing, measurements, clipping planes, and
other larger features are out of scope for now. If you want to work on one of
them, please open an issue first so we can agree on the approach.
