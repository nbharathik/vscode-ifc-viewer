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
  state.json        written by the viewer
  inbox/<id>.json   commands written by the agent
  outbox/<id>.json  answers written by the viewer
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
      "loadedAt": "2026-09-25T11:59:40.000Z", "isolated": false }
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
is `null` while a model is still loading.

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

## Safety

The viewer stays read-only. Commands cannot change IFC files, run code, or
use the network. Model paths cannot leave the workspace folder, including
through links, and command sizes and ages are bounded by settings.

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
