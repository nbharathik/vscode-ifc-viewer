// Extension entry: registers the custom editor and the two commands, and exposes
// a small API (onDidLoadModel) that reports each loaded model back to the host so
// the host tests can assert the host/webview round-trip.
import * as vscode from 'vscode';
import { IfcEditorProvider } from './ifcEditorProvider.js';
import type { LoadedStats } from './protocol.js';

export interface IfcViewerApi {
  readonly onDidLoadModel: vscode.Event<LoadedStats>;
  /** The most recently loaded model's stats (test convenience). */
  getLastLoaded(): LoadedStats | undefined;
}

export function activate(context: vscode.ExtensionContext): IfcViewerApi {
  const loadedEmitter = new vscode.EventEmitter<LoadedStats>();
  let lastLoaded: LoadedStats | undefined;

  const { provider, disposable } = IfcEditorProvider.register(context, (stats) => {
    lastLoaded = stats;
    loadedEmitter.fire(stats);
  });

  context.subscriptions.push(
    disposable,
    loadedEmitter,
    vscode.commands.registerCommand('vscodeIfcViewer.resetView', () => {
      provider.postCommandToActive('resetView');
    }),
    vscode.commands.registerCommand('vscodeIfcViewer.showStatistics', () => {
      provider.postCommandToActive('showStatistics');
    }),
  );

  return {
    onDidLoadModel: loadedEmitter.event,
    getLastLoaded: () => lastLoaded,
  };
}

export function deactivate(): void {
  // no-op
}
