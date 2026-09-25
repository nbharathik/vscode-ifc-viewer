// Extension entry: registers the custom editor, the commands, the agent
// bridge and auto-reload, and exposes a small API (onDidLoadModel) that
// reports each loaded model back so the host tests can assert round-trips.
import * as vscode from 'vscode';
import { IfcEditorProvider } from './ifcEditorProvider.js';
import { AgentBridge } from './bridge.js';
import { AutoReloader } from './autoReload.js';
import { readSettings } from './settings.js';
import type { ExtensionSettings } from './settings.js';
import type { LoadedStats } from './protocol.js';

export interface IfcViewerApi {
  readonly onDidLoadModel: vscode.Event<LoadedStats>;
  /** The most recently loaded model's stats (test convenience). */
  getLastLoaded(): LoadedStats | undefined;
}

let bridge: AgentBridge | undefined;

function loadSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('ifcViewer');
  return readSettings((key) => config.get(key));
}

export function activate(context: vscode.ExtensionContext): IfcViewerApi {
  const loadedEmitter = new vscode.EventEmitter<LoadedStats>();
  let lastLoaded: LoadedStats | undefined;
  let settings = loadSettings();

  const { provider, disposable } = IfcEditorProvider.register(context, (stats) => {
    lastLoaded = stats;
    loadedEmitter.fire(stats);
  });
  const agentBridge = new AgentBridge(context, provider, () => settings);
  bridge = agentBridge;
  provider.setHooks({
    agentStatus: (uri) => agentBridge.statusFor(uri),
    webviewConfig: () => ({
      showLegend: settings.highlightLegend.visible,
      revealHiddenCategories: settings.agentBridge.revealHiddenCategories,
    }),
    toggleAgent: (uri) => void agentBridge.toggleFor(uri),
  });
  const reloader = new AutoReloader(provider, () => settings, (uri) => agentBridge.isConnectedUri(uri));

  /** Folder for the connect/disconnect commands: argument, active viewer, or a pick. */
  async function chooseFolder(
    arg: unknown,
    candidates: readonly vscode.WorkspaceFolder[],
  ): Promise<vscode.WorkspaceFolder | undefined> {
    if (arg instanceof vscode.Uri) return vscode.workspace.getWorkspaceFolder(arg);
    const active = provider.activePanel();
    const fromPanel = active ? vscode.workspace.getWorkspaceFolder(active.uri) : undefined;
    if (fromPanel && candidates.some((f) => f.uri.toString() === fromPanel.uri.toString())) {
      return fromPanel;
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) return undefined;
    const picked = await vscode.window.showQuickPick(
      candidates.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { placeHolder: 'Workspace folder' },
    );
    return picked?.folder;
  }

  context.subscriptions.push(
    disposable,
    loadedEmitter,
    agentBridge,
    reloader,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('ifcViewer')) return;
      settings = loadSettings();
      void agentBridge.applySettings();
    }),
    vscode.commands.registerCommand('vscodeIfcViewer.resetView', () => {
      provider.postCommandToActive('resetView');
    }),
    vscode.commands.registerCommand('vscodeIfcViewer.showStatistics', () => {
      provider.postCommandToActive('showStatistics');
    }),
    vscode.commands.registerCommand('vscodeIfcViewer.toggleTree', () => {
      provider.postCommandToActive('toggleTree');
    }),
    vscode.commands.registerCommand('vscodeIfcViewer.toggleProperties', () => {
      provider.postCommandToActive('toggleProperties');
    }),
    vscode.commands.registerCommand('vscodeIfcViewer.connectAgent', async (arg?: unknown) => {
      if (!settings.agentBridge.enabled) {
        const open = await vscode.window.showInformationMessage(
          'Agent connections are turned off in the IFC Viewer settings.',
          'Open Settings',
        );
        if (open) {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'ifcViewer.agentBridge');
        }
        return false;
      }
      const local = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
      const folder = await chooseFolder(arg, local);
      if (!folder) {
        void vscode.window.showInformationMessage('Open a local folder to connect an agent.');
        return false;
      }
      try {
        await agentBridge.connect(folder);
        return true;
      } catch (err) {
        void vscode.window.showErrorMessage(`IFC Viewer: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }),
    vscode.commands.registerCommand('vscodeIfcViewer.disconnectAgent', async (arg?: unknown) => {
      const folder = await chooseFolder(arg, agentBridge.connectedFolders());
      if (!folder) return false;
      await agentBridge.disconnect(folder);
      return true;
    }),
    vscode.commands.registerCommand('vscodeIfcViewer.copySelectionGlobalId', async () => {
      const panels = provider.allPanels();
      const panel = provider.activePanel() ?? (panels.length === 1 ? panels[0] : undefined);
      if (!panel) {
        void vscode.window.showInformationMessage('Open an IFC file in the viewer first.');
        return undefined;
      }
      const selection = await panel.requestSelection(5000);
      if (!selection) {
        void vscode.window.showInformationMessage('Select an element in the IFC viewer first.');
        return undefined;
      }
      await vscode.env.clipboard.writeText(selection.globalId);
      vscode.window.setStatusBarMessage(`Copied GlobalId ${selection.globalId}`, 3000);
      return selection.globalId;
    }),
  );

  void agentBridge.restore().catch((err) =>
    vscode.window.showErrorMessage(`IFC Viewer: could not reconnect the agent: ${String(err)}`),
  );

  return {
    onDidLoadModel: loadedEmitter.event,
    getLastLoaded: () => lastLoaded,
  };
}

/** Mark connected folders closed (open: false) so agents stop waiting on us. */
export async function deactivate(): Promise<void> {
  await bridge?.shutdown();
  bridge = undefined;
}
