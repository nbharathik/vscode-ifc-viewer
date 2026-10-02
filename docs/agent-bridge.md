# Agent bridge protocol

IFC Viewer can pair with an AI agent, such as Claude Code with the IFC Skills
pack. The agent sees what the user selects and can highlight, isolate,
select, and frame elements by IFC GlobalId, or open and reload models. The
two sides exchange small JSON files in the workspace folder; neither imports
the other. This page is the contract (protocol version 1).

## Connecting

The bridge is off until the user clicks **Connect to agent** (the plug icon
in the viewer toolbar) or runs **IFC Viewer: Connect to Agent**. While a
folder is connected the viewer maintains:

```
<workspace folder>/.ifc-skills/viewer/
  SKILL.md          agent guide written by the viewer on connect
  mcp-shim.mjs      stdio shim for the live model tools (see below)
  server.json       where the tool server listens right now (url, token)
  state.json        written by the viewer
  inbox/<id>.json   commands written by the agent
  outbox/<id>.json  answers written by the viewer
```

`SKILL.md` is a short, agent-facing summary of this page, stamped with the
viewer version and rewritten on every connect. To have an agent read it, add
this line to its instructions (for example `CLAUDE.md`); the viewer offers to
copy it the first time you connect a workspace:

```
When .ifc-skills/viewer/SKILL.md exists, read it before showing results in the IFC Viewer.
```

Agents should not create this folder themselves. The viewer is live when
`state.json` has `"open": true` and `heartbeatAt` is no older than three
times `heartbeatSeconds`. Disconnecting removes the folder again (setting
`ifcViewer.agentBridge.removeFolderOnDisconnect`). The viewer adds a
`.gitignore` so none of it is committed.

## state.json

Replaced atomically; written on connect, on every heartbeat, and within
150 ms of a change.

```json
{
  "protocol": 1,
  "viewer": { "id": "BharathikannanN.vscode-ifc-viewer", "version": "1.4.0", "uriScheme": "vscode" },
  "open": true,
  "heartbeatAt": "2026-09-25T12:00:00.000Z",
  "heartbeatSeconds": 10,
  "models": [
    { "path": "models/house.ifc", "active": true, "fileMtimeMs": 1790000000000,
      "loadedAt": "2026-09-25T11:59:40.000Z", "isolated": false,
      "engine": "ifcopenshell", "editable": true, "dirty": false }
  ],
  "selection": [
    { "model": "models/house.ifc", "globalId": "2O2Fr$t4X7Zf8NOew3FLOH",
      "ifcClass": "IfcWall", "name": "Basic Wall:Exterior" }
  ],
  "highlights": [
    { "model": "models/house.ifc", "label": "No fire rating", "color": "#e53935", "count": 34 }
  ],
  "isolated": false
}
```

Paths are relative to the workspace folder with forward slashes. `loadedAt`
is `null` while a model is still loading. `engine` is `ifcopenshell` when the
viewer holds the model in IfcOpenShell (live, editable) and `web-ifc` when it is
read-only; `editable` says whether the edit and query tools work, and `dirty`
whether the model has unsaved edits (see [Live model tools](#live-model-tools)).

## Commands

Write each command to a temporary name, then rename it to
`inbox/<id>.json`; only `*.json` files are read.

| Field | Required | Meaning |
| --- | --- | --- |
| `protocol` | yes | `1` |
| `id` | yes | Unique id, 1 to 128 of `A-Z a-z 0-9 . _ -` (not starting with `.`). Names the answer file. |
| `createdAt` | yes | Epoch milliseconds, epoch seconds, or ISO 8601. Commands older than 60 seconds are rejected. |
| `op` | yes | `open`, `reload`, `select`, `highlight`, `isolate`, `fit`, or `clear`. |
| `model` | for `open` and `reload` | Path inside the workspace folder, ending in `.ifc`. Otherwise defaults to the focused or only open model. |
| `globalIds` | for `select`, `highlight`, `isolate`, `fit` | Up to 50000 GlobalIds. |
| `label` | no | Highlight group name (default `agent`); for `clear`, the one group to remove. |
| `color` | no | `#rgb`, `#rrggbb`, or a CSS colour name. |
| `what` | no | For `clear`: `highlight`, `isolate`, `selection`, or `all`. Defaults to `highlight` when a `label` is given, otherwise `all`. |

| op | Effect |
| --- | --- |
| `open` | Opens or reveals the model without taking focus; answers once it has loaded. |
| `reload` | Reads the file again, keeping the camera, selection, and highlights. |
| `select` | Selects the first matching element. |
| `highlight` | The group `label` becomes exactly these elements, shown in the legend with its count. |
| `isolate` | Hides everything except these elements. |
| `fit` | Frames these elements. |
| `clear` | Removes highlight groups, the isolate, and/or the selection. |

Viewer operations open the named model first when needed. Storeys,
buildings, and aggregates expand to their contents. GlobalIds match
products (walls, slabs, spaces, openings, storeys, and so on) and the
project; property sets, types, and groups do not match and are reported as
missing.

## Answers

```json
{
  "protocol": 1,
  "id": "hl-7f3a",
  "ok": true,
  "requested": 35,
  "applied": 34,
  "missing": ["0abcdefghijklmnopqrstu"],
  "model": "models/house.ifc",
  "completedAt": "2026-09-25T12:00:00.412Z"
}
```

`ok: false` comes with an `error` sentence for invalid, expired, or
unresolvable commands. Answers are removed after ten minutes.

## Reloads

While connected, a model reloads when its file changes on disk and keeps its
camera, selection, and highlights, matched again by GlobalId. Write IFC
files through a temporary file and a rename, and keep GlobalIds stable.

## Live model: Python client

When Python with IfcOpenShell is available the viewer keeps each open model in
IfcOpenShell (see [editing.md](editing.md)). While connected it writes
`.ifc-skills/viewer/ifc_live.py`, a dependency-free client (Python 3.8 or newer)
that runs code against that live model. Any agent that can run a command, and
your own scripts, can use it with no registration:

```sh
python .ifc-skills/viewer/ifc_live.py state
python .ifc-skills/viewer/ifc_live.py query "print(len(model.by_type('IfcWall')))"
python .ifc-skills/viewer/ifc_live.py edit '[{"op":"setAttribute","globalId":"...","name":"Name","value":"X"}]'
python .ifc-skills/viewer/ifc_live.py repl      # interactive, variables persist
```

```python
import sys; sys.path.insert(0, ".ifc-skills/viewer")
from ifc_live import connect
live = connect()
print(live.query("print(model.schema)").output)
```

Scripts see `model` (an `ifcopenshell.file`), `ifcopenshell`, `api` and
`element_util`. **IFC Viewer: Add Agent Instructions** (also offered when you
connect) adds the lines that point an agent at this to `AGENTS.md`,
`.github/copilot-instructions.md`, or `CLAUDE.md`.

## Live model tools (MCP)

The same live model is also served as Model Context Protocol tools, for agents
that prefer them. They act on the very model the user sees, so there is no file
round trip and no reload.

The tool server listens on a loopback port that changes every session, behind a
bearer token. `server.json` holds the current `url` and `token`, and
`mcp-shim.mjs` is a dependency-free stdio shim (Node 18 or newer) that re-reads
`server.json` on every message and forwards it. Register the shim once; it keeps
working across sessions:

```json
{ "mcpServers": { "ifc-viewer": { "command": "node", "args": [".ifc-skills/viewer/mcp-shim.mjs"] } } }
```

When the viewer is not connected the shim still starts, lists no tools, and
tells the agent to click the plug icon.

| Tool | Effect |
| --- | --- |
| `get_state` | The same data as `state.json`. |
| `open`, `reload`, `select`, `highlight`, `isolate`, `fit`, `clear` | The viewer ops above, validated the same way. |
| `query` | Run a Python script against the live model (`model`, `ifcopenshell`, `api`, `element_util`). Edits it makes become one undoable change. |
| `edit` | Typed edits: `setAttribute`, `setProperty`, `removePset`, `deleteProduct`, `setPlacement`, `assignContainer`, `assignType`, `createProduct`. All apply or none do. |
| `save` | Ask the user to write unsaved changes to disk. A modal prompt; the user may decline. |

Edits change the model in memory: the viewer updates immediately, highlights
the changed elements as the group "Changed by agent", and shows the file as
unsaved. They reach disk only when the user saves, and each can be undone with
the editor's Undo. `reload` is refused while a model has unsaved changes.

## Safety

The file protocol cannot change IFC files, run code, or use the network. Model
paths cannot leave the workspace folder, including through links, and command
sizes and ages are bounded by settings.

The live tools can change the in-memory model and run Python (`query`), so they
are limited: loopback only, a random token per session, no browser access
(requests with an `Origin` header are refused), trusted workspaces only, and
scripts can be turned off with `ifcViewer.engine.allowScripts`. Nothing is
written to disk without the user saving.

## Minimal client (Python)

```python
import json, os, time, uuid
from pathlib import Path

def send(root, op, **fields):
    bridge = Path(root) / ".ifc-skills" / "viewer"
    cmd_id = f"{op}-{uuid.uuid4().hex[:12]}"
    cmd = {"protocol": 1, "id": cmd_id, "createdAt": int(time.time() * 1000), "op": op, **fields}
    tmp = bridge / "inbox" / f"{cmd_id}.json.tmp"
    tmp.write_text(json.dumps(cmd), encoding="utf-8")
    os.replace(tmp, bridge / "inbox" / f"{cmd_id}.json")
    answer = bridge / "outbox" / f"{cmd_id}.json"
    for _ in range(600):
        try:
            return json.loads(answer.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            time.sleep(0.1)
    raise TimeoutError(cmd_id)

# send(".", "highlight", model="models/house.ifc", label="No fire rating",
#      color="#e53935", globalIds=["2O2Fr$t4X7Zf8NOew3FLOH"])
```
