// The live IfcOpenShell engine inside VS Code: a session per document, edits
// that mark the tab dirty and respond to the editor's own Undo and Save, and
// the agent tools over HTTP and through the stdio shim. Skipped when no Python
// with IfcOpenShell is installed.
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { IfcViewerApi } from '../../extension.js';

const EXTENSION_ID = 'BharathikannanN.vscode-ifc-viewer';
const MODEL = 'models/small.ifc';
const WALL = '0000000000000000000009';
const VIEW_TYPE = 'vscodeIfcViewer.editor';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(probe: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await sleep(100);
  }
}

interface ServerFile {
  url: string;
  token: string;
}

describe('live IfcOpenShell engine', function () {
  this.timeout(240000);
  const workspace = process.env.IFC_TEST_WORKSPACE ?? '';
  const modelPath = path.join(workspace, MODEL);
  const bridgeDir = path.join(workspace, '.ifc-skills', 'viewer');
  let api: IfcViewerApi;
  let uri: vscode.Uri;
  let folder: vscode.WorkspaceFolder;
  let rpcId = 1;

  const activeTabDirty = (): boolean => vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty ?? false;

  async function rpc(method: string, params?: Record<string, unknown>): Promise<{ result?: any; error?: any }> {
    const info = JSON.parse(fs.readFileSync(path.join(bridgeDir, 'server.json'), 'utf8')) as ServerFile;
    const response = await fetch(info.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    });
    return (await response.json()) as { result?: any; error?: any };
  }

  async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const reply = await rpc('tools/call', { name, arguments: args });
    assert.ok(reply.result, JSON.stringify(reply));
    const text = reply.result.content[0].text as string;
    return { isError: reply.result.isError === true, text, json: safeJson(text) };
  }

  function safeJson(text: string): any {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  before(async function () {
    if (!workspace) this.skip();
    api = await vscode.extensions.getExtension<IfcViewerApi>(EXTENSION_ID)!.activate();
    const discovery = await api.engine.manager.discover();
    if (!discovery.ok) this.skip();
    folder = vscode.workspace.workspaceFolders![0];
    uri = vscode.Uri.file(modelPath);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await vscode.commands.executeCommand('vscodeIfcViewer.disconnectAgent', folder.uri).then(undefined, () => undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  /** Run an editor command (undo/redo) until its effect shows; the first try can precede editor focus. */
  async function runEditorCommand(command: string, done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await vscode.commands.executeCommand(command);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (done()) return;
        await sleep(100);
      }
    }
    const tabs = vscode.window.tabGroups.all.flatMap((g) =>
      g.tabs.map((t) => `${t.label}${t.isActive ? ' (active)' : ''}${t.isDirty ? ' (dirty)' : ''}`),
    );
    throw new Error(`timeout: effect of ${command}; tabs: ${tabs.join(', ')}; focused: ${vscode.window.state.focused}`);
  }

  it('starts a session for an opened model and serves the live tree', async () => {
    const loaded = new Promise<void>((resolve) => {
      const sub = api.onDidLoadModel(() => {
        sub.dispose();
        resolve();
      });
    });
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
    await loaded;
    await until(() => api.sessionFor(uri)?.ready === true, 90000, 'session ready');
    const session = api.sessionFor(uri)!;
    assert.strictEqual(session.state.engine, 'ifcopenshell');
    assert.strictEqual(session.state.canEdit, true);
    const tree = await session.read<{ type: string; children: unknown[] }>('tree');
    assert.strictEqual(tree.type, 'IfcProject');
    const found = await session.read<{ found: { globalId: string; ifcClass: string }[] }>('resolveGlobalIds', { ids: [WALL] });
    assert.deepStrictEqual(found.found.map((f) => f.ifcClass), ['IfcWall']);
  });

  it('marks the tab dirty on an edit and clears it with the editor Undo', async () => {
    const session = api.sessionFor(uri)!;
    const result = await session.edit([{ op: 'setAttribute', globalId: WALL, name: 'Name', value: 'Renamed by test' }], 'user');
    assert.ok(result.delta, 'edit produced a delta');
    assert.strictEqual(result.delta!.changed[0].globalId, WALL);
    assert.strictEqual(result.patch, null, 'a name change needs no geometry');
    await until(() => activeTabDirty(), 10000, 'tab dirty after edit');
    assert.strictEqual(session.dirty, true);

    await runEditorCommand('undo', () => !session.dirty);
    await until(() => !activeTabDirty(), 10000, 'tab clean after undo');
    const props = await session.read<{ attributes: { name: string; value: unknown }[] }>('properties', {
      id: result.delta!.changed[0].id,
    });
    assert.notStrictEqual(props.attributes.find((a) => a.name === 'Name')?.value, 'Renamed by test');

    await runEditorCommand('redo', () => session.dirty);
    await runEditorCommand('undo', () => !session.dirty);
  });

  it('serves agent tools over HTTP and reflects edits in state', async () => {
    assert.strictEqual(await vscode.commands.executeCommand('vscodeIfcViewer.connectAgent', folder.uri), true);
    await until(() => fs.existsSync(path.join(bridgeDir, 'server.json')), 15000, 'server.json');
    assert.ok(fs.existsSync(path.join(bridgeDir, 'mcp-shim.mjs')), 'shim written');

    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.strictEqual(init.result.serverInfo.name, 'ifc-viewer');
    const list = await rpc('tools/list');
    const names = list.result.tools.map((t: { name: string }) => t.name);
    for (const expected of ['get_state', 'query', 'edit', 'save', 'highlight', 'select']) {
      assert.ok(names.includes(expected), `tool ${expected}`);
    }

    const state = (await tool('get_state')).json;
    assert.strictEqual(state.models[0].editable, true);
    assert.strictEqual(state.models[0].engine, 'ifcopenshell');
    assert.strictEqual(state.models[0].dirty, false);

    const count = await tool('query', { code: "print(len(model.by_type('IfcWall')))" });
    assert.strictEqual(count.isError, false, count.text);
    assert.strictEqual(count.json.output.trim(), '6');
    assert.strictEqual(count.json.changed, false);

    const edit = await tool('edit', {
      ops: [{ op: 'setAttribute', globalId: WALL, name: 'Name', value: 'Agent renamed' }],
    });
    assert.strictEqual(edit.isError, false, edit.text);
    assert.strictEqual(edit.json.changed, true);
    assert.strictEqual(edit.json.elements[0].globalId, WALL);

    await until(async () => (await tool('get_state')).json.models[0].dirty === true, 10000, 'state dirty');
    await until(() => activeTabDirty(), 10000, 'tab dirty after agent edit');

    const bad = await tool('edit', { ops: [{ op: 'setAttribute', id: 99999999, name: 'Name', value: 'x' }] });
    assert.strictEqual(bad.isError, true);
    assert.match(bad.text, /no entity/);

    const highlight = await tool('highlight', { globalIds: [WALL], label: 'from-test' });
    assert.strictEqual(highlight.isError, false, highlight.text);
    assert.strictEqual(highlight.json.applied, 1);

    const unauthorised = await fetch(JSON.parse(fs.readFileSync(path.join(bridgeDir, 'server.json'), 'utf8')).url, {
      method: 'POST',
      body: '{}',
    });
    assert.strictEqual(unauthorised.status, 401);
  });

  it('saves through the editor without triggering a reload', async () => {
    const session = api.sessionFor(uri)!;
    assert.strictEqual(session.dirty, true);
    let loads = 0;
    const sub = api.onDidLoadModel(() => loads++);
    await vscode.commands.executeCommand('workbench.action.files.save');
    await until(() => !session.dirty, 15000, 'session clean after save');
    await until(() => !activeTabDirty(), 15000, 'tab clean after save');
    const text = fs.readFileSync(modelPath, 'utf8');
    assert.ok(text.includes('Agent renamed'), 'the edit reached the file');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(modelPath)).filter((n) => n.endsWith('.tmp')), []);
    // Auto-reload would fire within ~1.5 s of a file change; our own write must not.
    await sleep(3000);
    sub.dispose();
    assert.strictEqual(loads, 0, 'saving must not reload the model');
  });

  it('gives any agent or script live access through the Python client', async function () {
    assert.ok(fs.existsSync(path.join(bridgeDir, 'ifc_live.py')), 'client written on connect');
    const discovery = await api.engine.manager.discover();
    assert.ok(discovery.ok);
    const py = discovery.python;
    const client = path.join(bridgeDir, 'ifc_live.py');

    // Async on purpose: the tool server lives in this extension host, so a
    // blocking spawn would freeze the very process the client is calling.
    const run = (args: string[], input?: string): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = childProcess.spawn(py.command, [...py.args, ...args], {
          cwd: workspace,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill(), 60000);
        child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
        child.on('error', reject);
        child.on('close', (status) => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr });
        });
        child.stdin.end(input ?? '');
      });

    const state = await run([client, 'state']);
    assert.strictEqual(state.status, 0, state.stderr);
    assert.strictEqual(JSON.parse(state.stdout).models[0].editable, true);

    const count = await run([client, 'query', "print(len(model.by_type('IfcWall')))"]);
    assert.strictEqual(count.status, 0, count.stderr);
    assert.strictEqual(count.stdout.trim(), '6');

    const failing = await run([client, 'query', 'raise RuntimeError("boom")']);
    assert.strictEqual(failing.status, 1);
    assert.match(failing.stderr, /boom/);

    // An edit through the client reaches the viewer: dirty tab, and VS Code Undo reverts it.
    const session = api.sessionFor(uri)!;
    const edit = await run([
      client, 'edit', JSON.stringify([{ op: 'setAttribute', globalId: WALL, name: 'Name', value: 'Client edit' }]),
    ]);
    assert.strictEqual(edit.status, 0, edit.stderr);
    assert.strictEqual(JSON.parse(edit.stdout).changed, true);
    await until(() => session.dirty, 10000, 'dirty after client edit');
    await until(() => activeTabDirty(), 10000, 'tab dirty after client edit');
    await runEditorCommand('undo', () => !session.dirty);

    // The REPL keeps variables between lines and echoes expressions.
    const repl = await run(
      [client, 'repl'],
      ["n = len(model.by_type('IfcWall'))", 'n', "for w in model.by_type('IfcSlab'):", '    print(w.is_a())', '', ':quit', ''].join('\n'),
    );
    assert.strictEqual(repl.status, 0, repl.stderr);
    // No terminal echoes the input here, so the echoed value follows the prompt directly.
    assert.match(repl.stdout, />>> 6\r?\n/);
    assert.match(repl.stdout, /IfcSlab/);

    // And it is importable from your own code, found next to the file.
    const imported = await run([
      '-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(bridgeDir)}); from ifc_live import connect; ` +
        "live = connect(); print(live.query('print(1+1)').output.strip()); print(live.state()['models'][0]['engine'])",
    ]);
    assert.strictEqual(imported.status, 0, imported.stderr);
    assert.deepStrictEqual(imported.stdout.trim().split(/\r?\n/), ['2', 'ifcopenshell']);
  });

  it('answers through the stdio shim and goes offline after disconnect', async function () {
    const shim = path.join(bridgeDir, 'mcp-shim.mjs');
    const hasNode = childProcess.spawnSync('node', ['--version'], { stdio: 'ignore' }).status === 0;
    const command = hasNode ? 'node' : process.execPath;
    const env = hasNode ? process.env : { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

    // A copy outside the bridge folder: it has no server.json next to it, like
    // a shim whose viewer is gone.
    const detached = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ifc-shim-')), 'mcp-shim.mjs');
    fs.copyFileSync(shim, detached);

    const ask = (messages: object[], script = shim): Promise<any[]> =>
      new Promise((resolve, reject) => {
        const child = childProcess.spawn(command, [script], { env, stdio: ['pipe', 'pipe', 'inherit'] });
        const replies: any[] = [];
        let buffer = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            replies.push(JSON.parse(buffer.slice(0, newline)));
            buffer = buffer.slice(newline + 1);
          }
        });
        child.on('error', reject);
        child.on('close', () => resolve(replies));
        for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
        child.stdin.end();
        setTimeout(() => child.kill(), 30000);
      });

    const live = await ask([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_state', arguments: {} } },
    ]);
    assert.strictEqual(live.length, 2, 'one answer per request, none for the notification');
    assert.strictEqual(live.find((r) => r.id === 1).result.serverInfo.name, 'ifc-viewer');
    assert.ok(JSON.parse(live.find((r) => r.id === 2).result.content[0].text).models.length >= 1);

    await vscode.commands.executeCommand('vscodeIfcViewer.disconnectAgent', folder.uri);
    assert.strictEqual(fs.existsSync(path.join(bridgeDir, 'server.json')), false, 'server.json removed on disconnect');

    const offline = await ask(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_state' } },
      ],
      detached,
    );
    assert.strictEqual(offline.length, 3);
    assert.match(offline.find((r) => r.id === 1).result.serverInfo.name, /not connected/);
    assert.deepStrictEqual(offline.find((r) => r.id === 2).result.tools, []);
    const call = offline.find((r) => r.id === 3).result;
    assert.strictEqual(call.isError, true);
    assert.match(call.content[0].text, /plug icon/);
  });
});
