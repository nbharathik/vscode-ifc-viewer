// Agent bridge, end to end inside VS Code: connect a workspace folder, drop
// command files into the inbox like an agent would, and read the acks and
// state.json back; then change the model on disk and watch it reload.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { IfcViewerApi } from '../../extension.js';

const EXTENSION_ID = 'BharathikannanN.vscode-ifc-viewer';
const MODEL = 'models/small.ifc';
const WALLS = [
  '0000000000000000000009',
  '000000000000000000000A',
  '000000000000000000000B',
  '000000000000000000000C',
  '000000000000000000000J',
  '000000000000000000000K',
];
const SLABS = ['000000000000000000000D', '000000000000000000000L'];
const UNKNOWN = 'NOT_A_REAL_GLOBALID_00';

interface Ack {
  protocol: number;
  id: string;
  ok: boolean;
  requested: number;
  applied: number;
  missing: string[];
  error?: string;
  model?: string;
  completedAt: string;
}

interface State {
  protocol: number;
  viewer: { id: string; version: string; uriScheme: string };
  open: boolean;
  heartbeatAt: string;
  models: { path: string; active: boolean; fileMtimeMs: number | null; loadedAt: string | null }[];
  selection: { model: string; globalId: string; ifcClass: string; name: string | null }[];
  highlights: { model: string; label: string; color: string; count: number }[];
  isolated: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await sleep(100);
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

describe('agent bridge (file protocol)', function () {
  this.timeout(180000);
  const workspace = process.env.IFC_TEST_WORKSPACE ?? '';
  const bridgeDir = path.join(workspace, '.ifc-skills', 'viewer');
  const statePath = path.join(bridgeDir, 'state.json');
  let api: IfcViewerApi;
  let folder: vscode.WorkspaceFolder;

  /** Write a command the way an agent should: temp file, then rename. */
  function drop(command: Record<string, unknown>, fileName?: string): string {
    const id = String(command.id);
    const body = { protocol: 1, createdAt: Date.now(), ...command };
    const target = path.join(bridgeDir, 'inbox', fileName ?? `${id}.json`);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(body));
    fs.renameSync(`${target}.tmp`, target);
    return target;
  }

  function ack(id: string): Promise<Ack> {
    return waitFor(() => readJson<Ack>(path.join(bridgeDir, 'outbox', `${id}.json`)), 60000, `ack ${id}`);
  }

  function state(predicate: (s: State) => boolean, label: string): Promise<State> {
    return waitFor(() => {
      const s = readJson<State>(statePath);
      return s && predicate(s) ? s : undefined;
    }, 60000, label);
  }

  before(async function () {
    if (!workspace) this.skip();
    api = await vscode.extensions.getExtension<IfcViewerApi>(EXTENSION_ID)!.activate();
    folder = vscode.workspace.workspaceFolders![0];
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('writes nothing before the folder is connected', () => {
    assert.strictEqual(fs.existsSync(path.join(workspace, '.ifc-skills')), false);
  });

  it('connecting creates the bridge folder and an open state.json', async () => {
    const ok = await vscode.commands.executeCommand('vscodeIfcViewer.connectAgent', folder.uri);
    assert.strictEqual(ok, true);
    const s = await state((x) => x.open, 'state open');
    assert.strictEqual(s.protocol, 1);
    assert.strictEqual(s.viewer.id, EXTENSION_ID);
    assert.ok(s.viewer.uriScheme.length > 0, 'uriScheme');
    assert.ok(!Number.isNaN(Date.parse(s.heartbeatAt)), 'heartbeatAt is ISO 8601');
    assert.deepStrictEqual(s.models, []);
    assert.strictEqual(fs.readFileSync(path.join(bridgeDir, '.gitignore'), 'utf8'), '*\n');
    assert.strictEqual(fs.readFileSync(path.join(workspace, '.ifc-skills', '.gitignore'), 'utf8'), '*\n');
  });

  it('an "open" command opens the model and acknowledges once it loaded', async () => {
    const inboxFile = drop({ id: 'open-1', op: 'open', model: MODEL });
    const a = await ack('open-1');
    assert.strictEqual(a.ok, true, a.error ?? '');
    assert.strictEqual(a.applied, 1);
    assert.strictEqual(a.model, MODEL);
    assert.strictEqual(fs.existsSync(inboxFile), false, 'the inbox file is removed');
    const s = await state((x) => x.models.some((m) => m.path === MODEL && m.loadedAt !== null), 'model loaded');
    assert.ok(typeof s.models[0].fileMtimeMs === 'number');
  });

  it('highlights walls by GlobalId and lists unknown ids as missing', async () => {
    drop({
      id: 'hl-1',
      op: 'highlight',
      model: MODEL,
      label: 'walls',
      color: '#e53935',
      globalIds: [...WALLS, UNKNOWN],
    });
    const a = await ack('hl-1');
    assert.deepStrictEqual(
      { ok: a.ok, requested: a.requested, applied: a.applied, missing: a.missing },
      { ok: true, requested: 7, applied: 6, missing: [UNKNOWN] },
    );
    const s = await state((x) => x.highlights.length === 1, 'highlights');
    assert.deepStrictEqual(s.highlights, [{ model: MODEL, label: 'walls', color: '#e53935', count: 6 }]);
  });

  it('selection reaches state.json and the copy command', async () => {
    // No "model": the command applies to the only open model in the folder.
    drop({ id: 'sel-1', op: 'select', globalIds: [WALLS[0]] });
    const a = await ack('sel-1');
    assert.strictEqual(a.ok, true, a.error ?? '');
    assert.strictEqual(a.applied, 1);
    const s = await state((x) => x.selection.length === 1, 'selection');
    assert.deepStrictEqual(s.selection, [
      { model: MODEL, globalId: WALLS[0], ifcClass: 'IfcWall', name: 'GF Wall South' },
    ]);
    const copied = await vscode.commands.executeCommand('vscodeIfcViewer.copySelectionGlobalId');
    assert.strictEqual(copied, WALLS[0]);
    assert.strictEqual(await vscode.env.clipboard.readText(), WALLS[0]);
  });

  it('answers invalid commands with ok: false instead of failing', async () => {
    drop({ id: 'bad-op', op: 'explode', model: MODEL });
    drop({ id: 'bad-path', op: 'open', model: '../outside.ifc' });
    drop({ id: 'bad-age', op: 'fit', model: MODEL, globalIds: WALLS, createdAt: Date.now() - 10 * 60_000 });
    fs.writeFileSync(path.join(bridgeDir, 'inbox', 'broken.json'), '{ "protocol": 1,');

    assert.match((await ack('bad-op')).error ?? '', /"op" must be one of/);
    assert.match((await ack('bad-path')).error ?? '', /outside the workspace folder/);
    assert.match((await ack('bad-age')).error ?? '', /expired/);
    const broken = await ack('broken');
    assert.strictEqual(broken.ok, false);
    assert.match(broken.error ?? '', /Invalid JSON/);
  });

  it('reloads when the file changes, keeping every highlight group and the selection', async () => {
    drop({ id: 'hl-2', op: 'highlight', model: MODEL, label: 'slabs', color: '#1e88e5', globalIds: SLABS });
    assert.strictEqual((await ack('hl-2')).applied, 2);
    const expected = [
      { model: MODEL, label: 'walls', color: '#e53935', count: 6 },
      { model: MODEL, label: 'slabs', color: '#1e88e5', count: 2 },
    ];
    const file = path.join(workspace, MODEL);

    // Two rewrites in a row: every group must survive both reloads.
    for (const revision of ['rev B', 'rev C']) {
      const before = await state((x) => x.models.length === 1, 'model state');
      const reloaded = new Promise<void>((resolve) => {
        const sub = api.onDidLoadModel(() => {
          sub.dispose();
          resolve();
        });
      });
      const text = fs
        .readFileSync(file, 'utf8')
        .replace(/'GF Wall South[^']*'/, `'GF Wall South (${revision})'`);
      fs.writeFileSync(file, text);
      await Promise.race([
        reloaded,
        sleep(60000).then(() => Promise.reject(new Error(`timeout: reload ${revision}`))),
      ]);
      const after = await state(
        (x) =>
          x.models[0]?.fileMtimeMs !== before.models[0].fileMtimeMs &&
          x.selection[0]?.name === `GF Wall South (${revision})` &&
          x.highlights.length === 2,
        `state after ${revision}`,
      );
      assert.deepStrictEqual(after.highlights, expected, revision);
      assert.strictEqual(after.selection[0].globalId, WALLS[0]);
    }
  });

  it('clear with a label removes only that group', async () => {
    drop({ id: 'clear-label', op: 'clear', model: MODEL, label: 'slabs' });
    const a = await ack('clear-label');
    assert.strictEqual(a.ok, true, a.error ?? '');
    assert.strictEqual(a.applied, 1);
    const s = await state((x) => x.highlights.length === 1, 'one group left');
    assert.strictEqual(s.highlights[0].label, 'walls');
    assert.strictEqual(s.selection.length, 1, 'the selection stays');
  });

  it('clear removes highlights and selection', async () => {
    drop({ id: 'clear-1', op: 'clear', model: MODEL });
    const a = await ack('clear-1');
    assert.strictEqual(a.ok, true, a.error ?? '');
    assert.strictEqual(a.applied, 2, 'one group plus the selection');
    await state((x) => x.highlights.length === 0 && x.selection.length === 0, 'cleared state');
  });

  it('disconnecting removes everything connecting created', async () => {
    const ok = await vscode.commands.executeCommand('vscodeIfcViewer.disconnectAgent', folder.uri);
    assert.strictEqual(ok, true);
    assert.strictEqual(fs.existsSync(path.join(workspace, '.ifc-skills')), false);
  });
});
