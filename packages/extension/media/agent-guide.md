---
name: ifc-viewer
description: How to work with the IFC Viewer extension that is connected to this project. Read it before querying or editing the live model, writing IFC scripts, or selecting, highlighting, isolating or opening elements in the viewer.
---

# IFC Viewer

Written by IFC Viewer {{VERSION}} when the user clicked Connect to agent. It is
rewritten on every connect and deleted when the user disconnects, so it always
matches the running viewer.

The viewer is for the user's eyes; never read numbers off it. When the model is
editable (`models[].editable` in `state.json`), answer questions from the live
model with `ifc_live.py` (below): it includes edits the user has not saved yet.
Otherwise answer from the IFC file itself, for example with IfcOpenShell. The two
programs talk through files in this folder, `.ifc-skills/viewer/`, which belongs
to the viewer: never create, edit or delete anything in it except command files
in `inbox/`.

## Is it connected?

`state.json` must have `"open": true` and a `heartbeatAt` (ISO 8601, UTC) no
older than 3 times `heartbeatSeconds` (default 10). The viewer replaces the file
atomically; retry a failed read after about 50 ms.

`state.json` holds:

- `models`: each with `path` (relative to the project root, forward slashes),
  `active`, `loadedAt`, `fileMtimeMs`, `engine` (`ifcopenshell` or `web-ifc`),
  `editable` and `dirty` (unsaved edits held by the viewer).
- `selection`: 0 or 1 entries with `model`, `globalId`, `ifcClass`, `name`.
- `highlights`: the groups on screen, each with `model`, `label`, `color`, `count`.

If it is not connected and the user wants to see something, say: "Open the model
in the IFC Viewer in your editor and click Agent in the status bar at the bottom
of the viewer (Connect to agent)." Otherwise do not mention the viewer.

## Send a command

Write JSON to `inbox/<id>.json.tmp`, then rename it to `inbox/<id>.json` (the
viewer reads only complete `.json` files).

| Field | Rules |
| --- | --- |
| `protocol` | `1` |
| `id` | Letters, digits, `.`, `_`, `-`; unique, for example `hl-` plus a uuid. |
| `createdAt` | Epoch milliseconds. Commands older than 60 s are refused. |
| `op` | `open`, `reload`, `select`, `highlight`, `isolate`, `fit`, `clear` |
| `model` | Path relative to the project root, ending in `.ifc`. Needed for `open` and `reload`; other ops default to the focused model. |
| `globalIds` | Up to 50,000 IFC GlobalIds. Needed for `select`, `highlight`, `isolate`, `fit`. |
| `label`, `color` | Highlight group name (default `agent`) and `#rrggbb` or a CSS colour name. |
| `what` | For `clear`: `highlight`, `isolate`, `selection` or `all`. |

What the ops do:

- `open` shows the model without stealing focus; `reload` re-reads it and keeps
  the camera, selection and highlights.
- `select` selects the first id; `fit` frames the ids; `isolate` hides everything
  else; `highlight` makes the group `label` exactly these ids (the same label
  replaces its group); `clear` removes highlights, the isolate or the selection.

Read the answer from `outbox/<id>.json`, polling every 100 to 200 ms for up to
60 s (`open` waits for the model to load), then delete it. It has `ok`,
`requested`, `applied`, `missing` and, on failure, `error`. If no answer comes,
delete your inbox file. Commands in one folder run one at a time.

## Live model: Python client (works for any agent)

When the viewer runs IfcOpenShell (`models[].editable` is `true` in `state.json`),
it holds the model in memory. `.ifc-skills/viewer/ifc_live.py` is a dependency-free
client (Python 3.8 or newer) that runs your code against that live model, the
very one the user sees: there is no file round trip and no reload. Use it from a
shell, or import it. It needs no registration.

```sh
python .ifc-skills/viewer/ifc_live.py state
python .ifc-skills/viewer/ifc_live.py query "print(len(model.by_type('IfcWall')))"
python .ifc-skills/viewer/ifc_live.py query -f ifc-scripts/find_missing_fire_rating.py   # or "-" for stdin
python .ifc-skills/viewer/ifc_live.py edit '[{"op":"setAttribute","globalId":"...","name":"Name","value":"X"}]'
python .ifc-skills/viewer/ifc_live.py highlight --ids ID1 ID2 --label "No fire rating"
python .ifc-skills/viewer/ifc_live.py repl        # interactive, variables persist
```

```python
import sys; sys.path.insert(0, ".ifc-skills/viewer")
from ifc_live import connect
live = connect()
print(live.query("print(model.schema)").output)
live.edit([{"op": "setAttribute", "globalId": "...", "name": "Name", "value": "X"}])
live.highlight(["<GlobalId>"], label="Result")
```

A script sees `model` (an `ifcopenshell.file`), `ifcopenshell`, `api`
(`ifcopenshell.api`) and `element_util`. A failing script exits non-zero and prints
its error; a script that changes the model is one undoable change.

## Keep reusable scripts

Write any script that changes the model, or that the user may want again, to a
file in `ifc-scripts/` at the project root and run it with `query -f`. Never put
scripts in `.ifc-skills/`: it is removed when the user disconnects. Inline
`query "..."` is fine for one-off reads.

- Look in `ifc-scripts/` first. If a script already does something close,
  adapt it (for example a new value or storey) instead of writing a new one.
- Start each script with a docstring: what it does, which model it expects,
  its parameters and the expected result.
- Put parameters in named constants at the top of the file, or read them from a
  JSON file next to it. Do not rely on variables left over from the REPL.
- Prefer selecting elements by rule (class, storey, property) over hard-coded
  GlobalIds, unless the user asked about specific elements.
- A script that creates elements checks for existing ones first, so running it
  twice does not duplicate them.
- Print what the script changed (class, GlobalId, before and after) so the
  output can be checked.
- Tell the user which file you wrote or changed. Saving a script does not save
  the model; only the user saves the `.ifc` file.

## Live model tools over MCP (optional)

The same live model is also served as MCP tools, for agents that prefer them.
The user registers them once per project with the command **IFC Viewer: Add
Agent Tools (MCP)** (writes `.mcp.json`, `.cursor/mcp.json` or `.vscode/mcp.json`).
By hand (Claude Code shown; any MCP client that can launch a stdio command works
the same way), the shim needs Node 18 or newer and re-reads the viewer's current
port on every call:

```json
{ "mcpServers": { "ifc-viewer": { "command": "node", "args": [".ifc-skills/viewer/mcp-shim.mjs"] } } }
```

| Tool | Use |
| --- | --- |
| `get_state` | Open models, unsaved changes, selection, highlight groups. |
| `query` | Run Python against the live model (`model`, `ifcopenshell`, `api`, `element_util` are predefined; `print()` results). |
| `edit` | Typed edits: `setAttribute`, `setProperty` (keeps the existing value type; a new property takes `valueType`: `text`, `number`, `boolean` or an IFC type such as `IfcLengthMeasure`), `addPset`, `removeProperty`, `removePset`, `deleteProduct`, `setPlacement`, `assignContainer`, `assignType`, `createProduct`. All apply or none do. |
| `open`, `reload`, `select`, `highlight`, `isolate`, `fit`, `clear` | The same viewer ops as the file protocol above. |
| `save` | Ask the user to write the unsaved model to disk. They are prompted and may decline. |

How edits work:

- Edits change the model in memory only. The viewer updates at once and marks
  the file as having unsaved changes. It does not colour what changed unless the
  user turned that on, so use `highlight` yourself when you want to point at
  something. Nothing reaches disk until the user saves; they can undo each
  edit with the editor's Undo, or revert the whole file.
- Edit only when the user asked for a change. Say what you changed (class,
  GlobalId, before and after) and offer `save`; never save on your own.
- Use `query` to read (counts, properties, quantities) and `edit` for plain
  changes. For anything else write the change with `ifcopenshell.api` inside a
  `query` script; it becomes one undoable change as well.
- `reload` is refused while the model has unsaved changes. Do not write the
  `.ifc` file yourself while the viewer holds unsaved edits.
- If `editable` is `false` (no Python or IfcOpenShell), use the read-only ops and
  your own scripts on the file, and tell the user they can click the engine icon
  in the viewer toolbar to set up editing.

## How to use it

- "This" or "the selected wall": read `selection[0]` and look it up by GlobalId
  instead of asking the user, in the live model when it is editable and in the
  file otherwise.
- "Show me": after a query that returns elements, offer to highlight them with a
  short label. Report "highlighted `applied` of `requested`" and name the
  `missing` ids. Branch on `ok`, never on the error text; `ok` with some
  `missing` is a normal partial success.
- Storeys, buildings and aggregates (curtain walls, stairs) expand to everything
  below them, so send the storey rather than tens of thousands of ids. Types,
  property sets, zones and systems do not resolve: expand them to products first.
- After an edit, highlight the changed GlobalIds with the label "changed by
  agent".
- Only when the model is not editable and you change the `.ifc` file yourself:
  the viewer reloads it when the file changes and re-applies highlights by
  GlobalId, so keep GlobalIds stable and write the file atomically (temp file,
  then `os.replace`).
- Spaces and openings are hidden by default; commands that target them show them.
