# Changelog

All notable changes to IFC Viewer are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 1.5.0

**Edit with IfcOpenShell, and a calmer viewer.** The viewer can now hold your
model in IfcOpenShell next to its fast web-ifc renderer. With Python and
IfcOpenShell installed you can edit properties in place and use Undo, Redo,
Save, and Revert. Without them nothing changes: the viewer is read-only and
opens files as fast as before.

### Added
- **Editing.** Double-click a value in the Item tab to change it. Values keep
  their type, enumerations and units are respected, and a value IfcOpenShell
  refuses is explained instead of applied. Add and remove properties and
  property sets. The file changes only when you save, and Save As and Revert
  work as in any editor.
- **Set Up IfcOpenShell** installs IfcOpenShell into a private environment after
  you confirm. Your own Python is never changed and IfcOpenShell is not bundled.
- **Live updates.** Moving or reshaping an element replaces just that element
  in the 3D view. Property edits never touch the geometry.
- **Agent access on the live model.** Connecting writes `ifc_live.py`, a small
  client that lets any agent or script query and edit the open model (with a
  REPL), plus optional MCP tools. **Add Agent Instructions** puts the lines
  into `AGENTS.md`, Copilot's instructions, or `CLAUDE.md`. **Add Agent Tools
  (MCP)** registers the tools in `.mcp.json`, `.cursor/mcp.json`, or
  `.vscode/mcp.json`. The Agent tab counts the elements an agent changed. They
  are not coloured by default; turn on `ifcViewer.engine.highlightAgentEdits`
  to show them in amber.
- **Reusable agent scripts.** The agent guide asks agents to save scripts that
  change the model in `ifc-scripts/` and run them with
  `ifc_live.py query -f`, so they stay in your project to read, fix and rerun.
- **A redesigned interface.** Search every command with `F3` or `Ctrl+K`, show
  the sidebar (Item, View, Model, Agent, Engine) with `N`, the tool shelf with
  `T`, and the tree with `O`. A status bar shows the selection, triangle count,
  engine, and agent state. A right-click menu acts on what is under the pointer,
  and an orientation gizmo snaps to standard views.
- **Settings:** `ifcViewer.engine.mode`, `start`, `maxFileSizeMb`,
  `scriptTimeoutSeconds`, `idleMinutes`, `python`, `allowScripts`, and
  `highlightAgentEdits`.

### Changed
- The engine and agent buttons moved from the toolbar to the status bar and the
  Engine and Agent tabs. The floating properties panel is now the Item tab, and
  statistics are the Model tab. The toolbar is a short tool shelf.
- Shortcuts with `Ctrl`, `Cmd`, or `Alt` no longer trigger the plain-letter
  shortcuts (for example `Ctrl+A` no longer shows all).

### Performance and safety
- IfcOpenShell starts only after the model has appeared, at low priority, so it
  does not slow the first paint. Files above 30 MB start it on first use, and
  files above `ifcViewer.engine.maxFileSizeMb` stay read-only.
- A hidden tab without unsaved edits frees its IfcOpenShell memory after ten
  minutes.
- If the model server crashes, or an agent script runs too long, it is
  restarted and your unsaved edits are restored where possible.
- Editing is available only for local files in trusted workspaces.

## 1.4.0

Agent pairing: connect an AI agent through files in the workspace, colour-coded
highlight groups with a legend, and automatic reload when the file changes.

## 1.3.0 and earlier

Spatial tree, properties, search and filters, section plane, standard views and
orthographic projection, and large-model loading with worker parsing and GPU
batching.
