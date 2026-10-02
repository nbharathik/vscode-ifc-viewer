# Editing with IfcOpenShell

The viewer draws models with web-ifc, which opens large files fast. When
Python with [IfcOpenShell](https://ifcopenshell.org/) is available it also holds
each open model in IfcOpenShell, which becomes the source of truth for the
model's data. That adds editing, live properties, and agent tools, and
everything keeps working without it.

## What you get

- **Editable properties.** Double-click a value in the Properties panel, type,
  and press Enter (Escape cancels). Attributes such as Name and property or
  quantity values are editable; GlobalId never is. Booleans and numbers keep
  their type.
- **Undo, redo, save.** Edits mark the tab as changed and use the editor's own
  Undo, Redo, Save, Save As, and Revert. The file on disk changes only when you
  save, and the write is atomic.
- **Live updates.** An edit that moves or reshapes an element replaces just that
  element in the 3D view; property edits do not touch the geometry. The tree
  refreshes when containment changes.
- **Your own code or any agent.** Connect, then run
  `python .ifc-skills/viewer/ifc_live.py repl` for an interactive prompt on the
  live model, or `query`, `edit` and `highlight` from a shell or a script (see
  [agent-bridge.md](agent-bridge.md)). It needs no registration, so it works with
  Copilot, Codex, Claude Code or anything that can run a command. Edits are
  highlighted as "Changed by agent", stay unsaved until you save, and can be
  undone.

## Setup

The toolbar has an engine icon (a chip). Hover it to see the state:

| State | Meaning |
| --- | --- |
| Active | IfcOpenShell holds the model: editing and agent tools work. |
| Starting | The model is already viewable; editing is a moment away. |
| Read-only | Python or IfcOpenShell was not found. Click the icon to set it up. |

Python 3.10 or newer with `ifcopenshell>=0.8.4,<0.9` is needed. The viewer looks
for it in this order: the setting `ifcViewer.engine.python`, a private
environment created by **IFC Viewer: Set Up IfcOpenShell**, then `py -3`,
`python3`, and `python` on the PATH. Setup creates that private environment in
the extension's storage and installs IfcOpenShell there, after you confirm. It
never changes your own Python, and IfcOpenShell (LGPL-3.0) is not bundled in the
extension.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `ifcViewer.engine.mode` | `auto` | `auto` uses IfcOpenShell when available; `web-ifc` never starts Python; `ifcopenshell` warns when it is missing. Reopen files after changing it. |
| `ifcViewer.engine.python` | empty | Interpreter to use (machine-scoped). |
| `ifcViewer.engine.allowScripts` | on | Let a connected agent run Python (`query`). Always off in untrusted workspaces. |
| `ifcViewer.engine.highlightAgentEdits` | on | Highlight what an agent changed. |
| `ifcViewer.agentBridge.mcpTools` | on | Serve the agent tools while connected. |

## Limits and notes

- Opening is as fast as before: web-ifc draws first, and IfcOpenShell loads the
  same file in the background. Generating geometry with IfcOpenShell alone is
  much slower on large models, so it is used only for elements an edit changed.
- Editing needs a local file in a trusted workspace. Virtual file systems,
  untrusted workspaces, and the web version of VS Code stay read-only.
- If the file changes on disk while you have unsaved edits, the viewer does not
  reload; save to overwrite it, or revert to load the new version.
- A deleted or created element appears or disappears at once, but new elements
  have no shape unless the script or agent creates one.
