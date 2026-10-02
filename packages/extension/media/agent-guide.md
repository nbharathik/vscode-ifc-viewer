---
name: ifc-viewer
description: How to show results in the IFC Viewer extension that is connected to this project. Read it before selecting, highlighting, isolating or opening elements in the viewer.
---

# IFC Viewer

Written by IFC Viewer {{VERSION}} when the user clicked Connect to agent. It is
rewritten on every connect and deleted when the user disconnects, so it always
matches the running viewer.

The viewer is for the user's eyes. Answer questions from the IFC file itself
(for example with IfcOpenShell) and never read numbers off the viewer. The two
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
in the IFC Viewer in your editor and click the plug icon (Connect to agent) in
the viewer toolbar." Otherwise do not mention the viewer.

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
python .ifc-skills/viewer/ifc_live.py query -f .ifc-skills/check.py      # or "-" for stdin
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

## Live model tools over MCP (optional)

The same live model is also served as MCP tools, for agents that prefer them.
Register once per project (Claude Code shown; any MCP client that can launch a
stdio command works the same way). The shim needs Node 18 or newer and re-reads
the viewer's current port on every call:

```json
{ "mcpServers": { "ifc-viewer": { "command": "node", "args": [".ifc-skills/viewer/mcp-shim.mjs"] } } }
```

| Tool | Use |
| --- | --- |
| `get_state` | Open models, unsaved changes, selection, highlight groups. |
| `query` | Run Python against the live model (`model`, `ifcopenshell`, `api`, `element_util` are predefined; `print()` results). |
| `edit` | Typed edits: `setAttribute`, `setProperty`, `removePset`, `deleteProduct`, `setPlacement`, `assignContainer`, `assignType`, `createProduct`. All apply or none do. |
| `open`, `reload`, `select`, `highlight`, `isolate`, `fit`, `clear` | The same viewer ops as the file protocol above. |
| `save` | Ask the user to write the unsaved model to disk. They are prompted and may decline. |

How edits work:

- Edits change the model in memory only. The viewer updates at once, highlights
  what changed as the group "Changed by agent", and marks the file as having
  unsaved changes. Nothing reaches disk until the user saves; they can undo each
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
  in the file instead of asking the user.
- "Show me": after a query that returns elements, offer to highlight them with a
  short label. Report "highlighted `applied` of `requested`" and name the
  `missing` ids. Branch on `ok`, never on the error text; `ok` with some
  `missing` is a normal partial success.
- Storeys, buildings and aggregates (curtain walls, stairs) expand to everything
  below them, so send the storey rather than tens of thousands of ids. Types,
  property sets, zones and systems do not resolve: expand them to products first.
- After an edit, highlight the changed GlobalIds with the label "changed by
  agent". The viewer reloads an open model when its file changes and re-applies
  highlights by GlobalId, so keep GlobalIds stable and write the file atomically
  (temp file, then `os.replace`).
- Spaces and openings are hidden by default; commands that target them show them.
