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
```

This installs the workspace dependencies for both packages.

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
npm run package -w packages/extension     # vsce package
```

These three run on every push and pull request in CI on `ubuntu-latest`.

Behind them sits a larger suite that runs in the maintainer tree before each
release: vitest for engine, tree, property and layer-boundary logic; Playwright
for headless-WebGL render and interaction tests; and `@vscode/test-electron` for
the extension host, including a run against the packaged `.vsix`. The suites and
the IFC files they load are not part of the published repository, so a fresh
clone cannot run them. Please describe how you verified a change in the pull
request, and open an issue first for anything that needs new test coverage.

## Conventions

- **Layer boundaries are enforced by tests.** `packages/extension` must not
  import `three` or `web-ifc`, and `packages/viewer-core` must not import
  `vscode`. Do not add an import that crosses those lines.
- **All engine access goes through the adapter** in
  `packages/viewer-core/src/engine/`. Nothing else may import `web-ifc`.
- **Structural assertions come first.** Visual snapshots exist as a secondary
  signal. A test should assert mesh counts, triangle counts, bounds, or DOM text
  so a snapshot difference is never the only thing that fails. Do not loosen a
  structural assertion to make a test pass.
- **Fixtures are generated, not downloaded.** Build a local set with
  `npm run fixtures` (Python + `ifcopenshell`) if you need IFC files to try the
  viewer against.

## Commits and pull requests

- Keep commits focused and write a clear subject line.
- Make sure the gate above is green.
- Call out user-visible changes in the pull request description so they can be
  picked up for the release notes.

## Scope

The viewer is deliberately read-only. Editing, measurements, clipping planes, and
other larger features are out of scope for now. If you want to work on one of
them, please open an issue first so we can agree on the approach.
