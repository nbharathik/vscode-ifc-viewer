import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { IfcViewerApi } from '../../extension.js';
import type { LoadedStats } from '../../protocol.js';

const EXTENSION_ID = 'BharathikannanN.vscode-ifc-viewer';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

describe('vscode-ifc-viewer extension host', () => {
  it('activates and exposes the custom editor', async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension<IfcViewerApi>(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be installed`);
    const api = await ext!.activate();
    assert.ok(typeof api.onDidLoadModel === 'function', 'API exposes onDidLoadModel');

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('vscodeIfcViewer.resetView'), 'resetView command registered');
    assert.ok(commands.includes('vscodeIfcViewer.showStatistics'), 'showStatistics command registered');
    assert.ok(commands.includes('vscodeIfcViewer.toggleTree'), 'toggleTree command registered');
    assert.ok(
      commands.includes('vscodeIfcViewer.toggleProperties'),
      'toggleProperties command registered',
    );
  });

  it('opens small.ifc in the custom editor and round-trips model-loaded', async function () {
    // Cold VS Code boots with software rendering can take over a minute on a
    // loaded host; the assertion is the round trip, not its speed (perf
    // budgets live in the Playwright suite and the bench).
    this.timeout(180000);
    const ext = vscode.extensions.getExtension<IfcViewerApi>(EXTENSION_ID)!;
    const api = await ext.activate();

    const fixtures = process.env.IFC_FIXTURES;
    assert.ok(fixtures, 'IFC_FIXTURES env should be set by runTest');
    const uri = vscode.Uri.file(path.join(fixtures!, 'small.ifc'));

    const loaded = new Promise<LoadedStats>((resolve) => {
      const sub = api.onDidLoadModel((stats) => {
        sub.dispose();
        resolve(stats);
      });
    });

    await vscode.commands.executeCommand('vscode.openWith', uri, 'vscodeIfcViewer.editor');

    const stats = await withTimeout(loaded, 150000, 'model-loaded');
    assert.strictEqual(stats.fileName, 'small.ifc');
    assert.strictEqual(stats.totalEntities, 190, 'entity count');
    assert.strictEqual(stats.meshCount, 9, 'mesh count');
    assert.strictEqual(stats.triangleCount, 128, 'triangle count');
  });
});
