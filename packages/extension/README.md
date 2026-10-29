# IFC Viewer for VS Code

Open `.ifc` building models in a fast 3D viewer inside VS Code. Browse the
spatial tree, select elements, read their properties, and with Python and
IfcOpenShell installed, edit them in place. An AI agent such as Claude Code,
Copilot, or Codex can work on the same live model and show its answers directly
in the 3D view.

![The IFC Viewer: spatial tree, 3D viewport with the orientation gizmo, tool shelf, sidebar, and status bar](https://raw.githubusercontent.com/nbharathik/vscode-ifc-viewer/main/docs/images/viewer.png)

## Features

- **Fast on large models.** Parsing runs in a worker, geometry streams in
  progressively, and rendering is GPU-batched.
- **3D navigation.** Orbit, pan, zoom, standard views, orthographic projection,
  a section plane, and an orientation gizmo you can click to snap to a view.
- **Model structure.** A spatial tree synchronized with the 3D selection, and
  every attribute, property set, and quantity of the selected element.
- **Find and focus.** Search by name, type, or GlobalId, filter by type and
  storey, and hide, isolate, or show elements.
- **Edit with IfcOpenShell.** Change values, add or remove properties and
  property sets, with Undo, Redo, Save, and Revert. The file changes only when
  you save.
- **AI agent pairing.** An agent sees your selection, highlights and frames
  elements, and can query and edit the live model through a small Python client
  or optional MCP tools.
- **At home in VS Code.** Follows your light or dark theme and remembers the
  camera, sidebar tab, and panels.

## A calm interface

Tools stay out of the way until you need them, and everything is a keystroke
away.

| Key | Action |
| --- | --- |
| `F3` or `Ctrl+K` | Search every command |
| `N` | Show or hide the sidebar (Item, View, Model, Agent, Engine) |
| `T` | Show or hide the tool shelf |
| `O` | Show or hide the spatial tree |
| `F` / `.` | Fit the model / fit the selection |
| `H` / `I` / `A` | Hide / isolate / show all |
| `Esc` | Clear the selection |
| `P` | Performance overlay |

Left-drag orbits, right-drag pans, the wheel zooms, a double-click fits an
element, and a right-click opens a menu for what is under the pointer.

![Command search listing the viewer's actions with their shortcuts](https://raw.githubusercontent.com/nbharathik/vscode-ifc-viewer/main/docs/images/search.png)

The status bar shows what is selected, how much is on screen, and the engine and
agent state. Click the engine or agent entry to open its tab in the sidebar.

## Edit with IfcOpenShell

Without Python the viewer is read-only and opens files exactly as fast as it
always did. With Python 3.10 or newer and IfcOpenShell, the model is also held
in IfcOpenShell, which becomes the source of truth for its data:

1. Open the **Engine** tab (click the engine entry in the status bar) and press
   **Set up IfcOpenShell**, or run **IFC Viewer: Set Up IfcOpenShell**. It
   installs IfcOpenShell into a private environment after you confirm and never
   touches your own Python.
2. Double-click a value in the **Item** tab, type, and press Enter. Use
   **+ Add property**, **+ Add property set**, and the remove buttons for
   structure.
3. Save as in any editor. Edits stay in memory until then, and the tab shows
   them as unsaved.

IfcOpenShell starts after the model has appeared, so first paint is not slowed,
and very large files start it on first use instead. Details are in
[docs/editing.md](https://github.com/nbharathik/vscode-ifc-viewer/blob/main/docs/editing.md).

## Pair with an AI agent

1. Open an `.ifc` file from a folder in your workspace.
2. Click **Agent** in the status bar, then **Connect to agent**.
3. Press **Add agent instructions** so your agent finds the guide, and, if it
   speaks MCP, **Add agent tools (MCP)**.

Connecting writes a short guide and a small Python client to
`.ifc-skills/viewer/`. Any agent or script can then work on the live model:

```sh
python .ifc-skills/viewer/ifc_live.py repl
python .ifc-skills/viewer/ifc_live.py query "print(len(model.by_type('IfcWall')))"
python .ifc-skills/viewer/ifc_live.py query -f ifc-scripts/set_fire_rating.py
```

The guide asks agents to keep reusable scripts in `ifc-scripts/` in your
project, so you can read, fix and rerun them later like any other code.

Highlight groups appear in a legend with clear buttons. The Agent tab counts the
elements an agent changed, and you can have them shown in amber by turning on
`ifcViewer.engine.highlightAgentEdits` (off by default, so updates stay clean).
Nothing is written to
your workspace until you connect, edits stay unsaved until you save, and
disconnecting removes the viewer's files again. Agent authors can find the full
protocol in
[docs/agent-bridge.md](https://github.com/nbharathik/vscode-ifc-viewer/blob/main/docs/agent-bridge.md).

## Commands and settings

Commands (all under "IFC Viewer"): **Reset View**, **Show Statistics**,
**Toggle Spatial Tree**, **Toggle Properties Panel**, **Copy Selection
GlobalId**, **Set Up IfcOpenShell**, **Select Engine**, **Show Log**,
**Connect to Agent**, **Disconnect from Agent**, **Add Agent Instructions**,
and **Add Agent Tools (MCP)**.

Search `ifcViewer` in Settings. The main ones:

| Setting | Meaning |
| --- | --- |
| `ifcViewer.engine.mode` | `auto`, `web-ifc` (never start Python), or `ifcopenshell` |
| `ifcViewer.engine.start` | When IfcOpenShell starts: on open, on first use, or by size |
| `ifcViewer.engine.maxFileSizeMb` | Larger files stay read-only |
| `ifcViewer.engine.scriptTimeoutSeconds` | Stops a runaway agent script and restores your edits |
| `ifcViewer.engine.idleMinutes` | Frees the memory of a hidden tab |
| `ifcViewer.engine.allowScripts` | Lets a connected agent run Python on the model |

## Limitations

- Editing needs a local file in a trusted workspace; remote and virtual file
  systems, untrusted workspaces, and the web version of VS Code stay read-only.
- IfcOpenShell needs roughly 8 to 10 times the file size in memory, so very
  large files stay read-only by default.
- Created elements have no shape unless a script or agent creates one.
- Tested on Windows. macOS and Linux should work but have had less testing.
- No measurement, BCF, multi-model federation, IFC5 or ifcx, or WebGPU yet.

## Credits and licenses

Extension code is licensed under MIT. Built on
[web-ifc](https://github.com/ThatOpen/engine_web-ifc) (MPL-2.0) and
[Three.js](https://threejs.org/) (MIT). Editing uses
[IfcOpenShell](https://ifcopenshell.org/) (LGPL-3.0), which runs as a separate
process and is installed on your request, never bundled.
