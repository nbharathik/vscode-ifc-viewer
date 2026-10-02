"""Live access to the model open in the IFC Viewer, from plain Python.

Written into .ifc-skills/viewer/ by the IFC Viewer when you click Connect to
agent. Standard library only, Python 3.8 or newer, nothing to install. The model
itself lives in the viewer's IfcOpenShell process: your code is sent there, runs
against the live model, and any edit shows in the 3D view at once. Nothing is
written to the .ifc file until you save in the editor.

In your own code:

    from ifc_live import connect
    live = connect()                       # finds the viewer next to this file or above the cwd
    print(live.query("print(len(model.by_type('IfcWall')))").output)
    live.edit([{"op": "setAttribute", "globalId": "...", "name": "Name", "value": "Wall A"}])
    live.highlight(["<GlobalId>", ...], label="Fire walls")

From a shell (any agent that can run a command can use this):

    python ifc_live.py state
    python ifc_live.py query "print(model.schema)"
    python ifc_live.py query -f script.py          # or "-" to read the script from stdin
    python ifc_live.py edit '[{"op":"setAttribute","globalId":"...","name":"Name","value":"X"}]'
    python ifc_live.py highlight --ids ID1 ID2 --label "My walls"
    python ifc_live.py repl                        # interactive; variables persist

Scripts see: model (ifcopenshell.file), ifcopenshell, api (ifcopenshell.api),
element_util (ifcopenshell.util.element). Edits made by a script are one
undoable change in the editor.
"""
import argparse
import codeop
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

__all__ = ["connect", "Live", "NotConnected", "ViewerError", "QueryResult"]

NOT_CONNECTED = (
    "The IFC Viewer is not connected. Open the model in VS Code and click the plug icon "
    "(Connect to agent) in the viewer toolbar, then try again."
)


class NotConnected(RuntimeError):
    """The viewer is closed, disconnected, or its tool server is turned off."""


class ViewerError(RuntimeError):
    """The viewer refused or failed the request (the message says why)."""


class QueryResult:
    """What a script printed, and what it changed."""

    def __init__(self, data):
        self.data = data
        self.output = data.get("output", "")
        self.error = data.get("error")
        self.changed = bool(data.get("changed"))
        self.elements = data.get("elements") or []

    def __str__(self):
        return self.output

    def __repr__(self):
        return "QueryResult(changed=%s, %d elements)" % (self.changed, len(self.elements))


def _candidate_files(start):
    here = Path(__file__).resolve().parent / "server.json"
    yield here
    folder = Path(start or Path.cwd()).resolve()
    for directory in [folder, *folder.parents]:
        yield directory / ".ifc-skills" / "viewer" / "server.json"


def _find_server_file(start=None):
    for candidate in _candidate_files(start):
        if candidate.is_file():
            return candidate
    return None


class Live:
    """A connection to the viewer's tool server. The port changes each session, so
    the address is read again from server.json on every call."""

    def __init__(self, server_file=None, model=None, timeout=300):
        self.server_file = Path(server_file) if server_file else None
        self.model = model
        self.timeout = timeout
        self._ids = 0

    # -- plumbing -----------------------------------------------------------
    def _target(self):
        file = self.server_file or _find_server_file()
        if file is None or not file.is_file():
            raise NotConnected(NOT_CONNECTED)
        try:
            info = json.loads(file.read_text(encoding="utf-8"))
            return info["url"], info["token"]
        except (OSError, ValueError, KeyError):
            raise NotConnected(NOT_CONNECTED)

    def _call(self, tool, timeout=None, **arguments):
        url, token = self._target()
        if self.model and "model" not in arguments:
            arguments["model"] = self.model
        arguments = {key: value for key, value in arguments.items() if value is not None}
        self._ids += 1
        body = json.dumps(
            {"jsonrpc": "2.0", "id": self._ids, "method": "tools/call", "params": {"name": tool, "arguments": arguments}}
        ).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={"content-type": "application/json", "authorization": "Bearer " + token},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                reply = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raise ViewerError("the viewer answered HTTP %d" % err.code)
        except (urllib.error.URLError, OSError):
            raise NotConnected(NOT_CONNECTED)
        if "error" in reply:
            raise ViewerError(reply["error"].get("message", "request failed"))
        result = reply["result"]
        text = result["content"][0]["text"] if result.get("content") else ""
        try:
            data = json.loads(text)
        except ValueError:
            data = {"text": text}
        if result.get("isError"):
            raise ViewerError(data.get("error") or data.get("text") or text)
        return data

    # -- what you can do ------------------------------------------------------
    def state(self):
        """Open models, unsaved changes, the selected element and highlight groups."""
        return self._call("get_state")

    def query(self, code, keep=False, model=None):
        """Run Python on the live model. `keep=True` keeps variables between calls and
        echoes a lone expression (what repl does). Raises ViewerError if the script fails."""
        return QueryResult(self._call("query", code=code, keepVariables=True if keep else None, model=model))

    def edit(self, ops, model=None):
        """Typed edits (setAttribute, setProperty, removePset, deleteProduct, setPlacement,
        assignContainer, assignType, createProduct). All apply or none do."""
        return self._call("edit", ops=ops, model=model)

    def highlight(self, global_ids, label=None, color=None, model=None):
        return self._call("highlight", globalIds=list(global_ids), label=label, color=color, model=model)

    def select(self, global_ids, model=None):
        return self._call("select", globalIds=list(global_ids), model=model)

    def isolate(self, global_ids, model=None):
        return self._call("isolate", globalIds=list(global_ids), model=model)

    def fit(self, global_ids, model=None):
        return self._call("fit", globalIds=list(global_ids), model=model)

    def clear(self, what=None, label=None, model=None):
        return self._call("clear", what=what, label=label, model=model)

    def open(self, model):
        return self._call("open", model=model)

    def reload(self, model):
        return self._call("reload", model=model)

    def save(self, model=None):
        """Ask the user to save the unsaved model to disk. They are prompted and may decline."""
        return self._call("save", timeout=600, model=model)


def connect(path=None, model=None):
    """Connect to the viewer. `path` is a project folder, server.json, or None to search
    next to this file and above the current directory."""
    live = Live(model=model)
    if path is not None:
        target = Path(path)
        live.server_file = target if target.is_file() else _find_server_file(target)
    live._target()  # fail now, with a clear message, if the viewer is not there
    return live


# -- command line ---------------------------------------------------------------

def _print_json(value):
    print(json.dumps(value, indent=2, ensure_ascii=False))


def _read_code(args):
    if args.file:
        return Path(args.file).read_text(encoding="utf-8")
    if args.code == "-":
        return sys.stdin.read()
    if args.code:
        return args.code
    raise SystemExit("query needs code, -f FILE, or '-' to read stdin")


def _ids(args):
    ids = list(args.ids or [])
    if ids == ["-"]:
        ids = [line.strip() for line in sys.stdin if line.strip()]
    if not ids:
        raise SystemExit("give at least one GlobalId with --ids")
    return ids


def repl(live):
    """An interactive prompt on the live model. Variables persist; edits are visible at once."""
    sys.stdout.write(
        "IFC Viewer live model. model, ifcopenshell, api, element_util are ready.\n"
        "Edits show in the viewer and stay unsaved until you save. :state  :save  :quit\n"
    )
    buffer = []
    while True:
        try:
            line = input("... " if buffer else ">>> ")
        except EOFError:
            print()
            return 0
        except KeyboardInterrupt:
            print("\nKeyboardInterrupt")
            buffer = []
            continue
        if not buffer and line.strip() in (":quit", ":q", "exit()", "quit()"):
            return 0
        if not buffer and line.strip() == ":state":
            _print_json(live.state())
            continue
        if not buffer and line.strip() == ":save":
            _print_json(live.save())
            continue
        buffer.append(line)
        source = "\n".join(buffer)
        try:
            complete = codeop.compile_command(source, "<repl>", "single") is not None or not line.strip()
        except (SyntaxError, ValueError, OverflowError):
            complete = True  # let the server report the syntax error
        if not complete:
            continue
        buffer = []
        try:
            result = live.query(source + "\n", keep=True)
            if result.output:
                sys.stdout.write(result.output if result.output.endswith("\n") else result.output + "\n")
            if result.changed:
                print("(changed %d element%s, unsaved)" % (len(result.elements), "" if len(result.elements) == 1 else "s"))
        except ViewerError as err:
            sys.stdout.write(str(err).rstrip() + "\n")
        except NotConnected as err:
            print(err)
            return 1


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Live access to the model open in the IFC Viewer.")
    parser.add_argument("-m", "--model", help="model path relative to the project root (default: the open model)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("state", help="show open models, selection and highlights")
    query = sub.add_parser("query", help="run Python on the live model")
    query.add_argument("code", nargs="?", help="Python source, or '-' to read it from stdin")
    query.add_argument("-f", "--file", help="read the script from a file")
    query.add_argument("--keep", action="store_true", help="keep variables between calls")
    edit = sub.add_parser("edit", help="apply typed edits (a JSON list of operations)")
    edit.add_argument("ops", help="JSON list, or '-' to read it from stdin")
    for name, help_text in (("highlight", "colour elements"), ("select", "select an element"),
                            ("isolate", "hide everything else"), ("fit", "frame elements")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--ids", nargs="+", required=True, help="GlobalIds, or '-' to read them from stdin")
        if name == "highlight":
            p.add_argument("--label")
            p.add_argument("--color")
    clear = sub.add_parser("clear", help="remove highlights, isolate or selection")
    clear.add_argument("--what", choices=["highlight", "isolate", "selection", "all"])
    clear.add_argument("--label")
    sub.add_parser("save", help="ask the user to save the model to disk")
    sub.add_parser("repl", help="interactive prompt on the live model")
    args = parser.parse_args(argv)

    live = Live(model=args.model)
    try:
        live._target()
        if args.command == "state":
            _print_json(live.state())
        elif args.command == "query":
            result = live.query(_read_code(args), keep=args.keep)
            sys.stdout.write(result.output)
            if result.changed:
                sys.stderr.write("(changed %d element%s, unsaved)\n" % (len(result.elements), "" if len(result.elements) == 1 else "s"))
        elif args.command == "edit":
            raw = sys.stdin.read() if args.ops == "-" else args.ops
            _print_json(live.edit(json.loads(raw)))
        elif args.command == "highlight":
            _print_json(live.highlight(_ids(args), label=args.label, color=args.color))
        elif args.command in ("select", "isolate", "fit"):
            _print_json(getattr(live, args.command)(_ids(args)))
        elif args.command == "clear":
            _print_json(live.clear(what=args.what, label=args.label))
        elif args.command == "save":
            _print_json(live.save())
        elif args.command == "repl":
            return repl(live)
    except NotConnected as err:
        sys.stderr.write(str(err) + "\n")
        return 2
    except ViewerError as err:
        sys.stderr.write(str(err).rstrip() + "\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
