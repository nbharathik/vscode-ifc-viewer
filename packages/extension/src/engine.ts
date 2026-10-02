// Engine control: decides per document whether IfcOpenShell gets a session,
// keeps the registry of live sessions, and owns the toolbar/command UI for
// choosing the engine and setting it up.
import * as vscode from 'vscode';
import { DocumentSession } from './server/documentSession.js';
import { ServerManager } from './server/serverManager.js';
import { setupManagedPython } from './server/pythonSetup.js';
import type { SessionHost } from './ifcEditorProvider.js';
import type { EngineMode, ExtensionSettings } from './settings.js';
import type { SessionState } from './protocol.js';

const MODE_LABELS: Record<EngineMode, { label: string; description: string }> = {
  auto: {
    label: 'Automatic',
    description: 'web-ifc draws the model; IfcOpenShell adds editing and queries when it is installed',
  },
  'web-ifc': { label: 'web-ifc only', description: 'read-only, no Python needed' },
  ifcopenshell: {
    label: 'IfcOpenShell required',
    description: 'warn when IfcOpenShell is missing (editing and agent tools need it)',
  },
};

export class EngineController implements SessionHost, vscode.Disposable {
  readonly manager: ServerManager;
  private readonly sessions = new Set<DocumentSession>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private warnedMissing = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly settings: () => ExtensionSettings,
    readonly output: vscode.OutputChannel,
  ) {
    this.manager = new ServerManager(context, settings, output);
    this.subscriptions.push(
      this.manager.onDidExit(() => {
        for (const session of this.sessions) session.markLost();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void vscode.window.showInformationMessage('Reopen your IFC files to enable editing in this trusted workspace.');
      }),
    );
  }

  /** Scripts need a trusted workspace and the setting on. */
  scriptsAllowed(): boolean {
    return this.settings().engine.allowScripts && vscode.workspace.isTrusted;
  }

  create(uri: vscode.Uri, backup: vscode.Uri | undefined): DocumentSession | null {
    if (this.settings().engine.mode === 'web-ifc') return null;
    if (uri.scheme !== 'file') return null;
    // The model server runs a Python found on this machine; do not start it
    // for a workspace the user has not trusted.
    if (!vscode.workspace.isTrusted) return null;
    const session = new DocumentSession(
      this.manager,
      uri.toString(),
      (backup ?? uri).fsPath,
      uri.fsPath,
      { allowScripts: () => this.scriptsAllowed() },
      backup !== undefined,
    );
    this.sessions.add(session);
    session.onDidChangeState((state) => this.onSessionState(state));
    return session;
  }

  /** Forget a session whose document closed. */
  release(session: DocumentSession): void {
    this.sessions.delete(session);
  }

  private onSessionState(state: SessionState): void {
    if (state.state !== 'unavailable' || this.warnedMissing) return;
    if (this.settings().engine.mode !== 'ifcopenshell') return;
    this.warnedMissing = true;
    void this.offerSetup(`IfcOpenShell is required by your settings but is not available. ${state.detail ?? ''}`);
  }

  private async offerSetup(message: string): Promise<void> {
    const setup = 'Set Up IfcOpenShell';
    const pick = await vscode.window.showWarningMessage(`IFC Viewer: ${message}`, setup, 'Show Log');
    if (pick === setup) await this.setup();
    else if (pick === 'Show Log') this.output.show(true);
  }

  async setup(): Promise<boolean> {
    return setupManagedPython(this.manager, this.output);
  }

  applySettings(): void {
    for (const session of this.sessions) session.setScriptsAllowed(this.scriptsAllowed());
  }

  /** Restart the server after the interpreter setting changed. */
  async interpreterChanged(): Promise<void> {
    await this.manager.restart();
    void vscode.window.showInformationMessage('Reopen your IFC files to use the new Python interpreter.');
  }

  /** Toolbar indicator click: a menu that fits the current state. */
  async showMenu(state: SessionState | undefined): Promise<void> {
    type Item = vscode.QuickPickItem & { run: () => PromiseLike<unknown> | void };
    const items: Item[] = [];
    const ready = state?.state === 'ready';
    if (ready) {
      const s = this.manager.state;
      const detail = s.state === 'ready' ? `Python ${s.info.python}, IfcOpenShell ${s.info.ifcopenshell}` : undefined;
      items.push({ label: '$(check) IfcOpenShell is active', description: detail, run: () => undefined });
    } else if (this.settings().engine.mode === 'web-ifc') {
      items.push({
        label: '$(play) Use IfcOpenShell',
        description: 'switch the engine setting to Automatic',
        run: () => this.setMode('auto'),
      });
    } else {
      items.push({
        label: '$(cloud-download) Set up IfcOpenShell',
        description: 'private Python environment, with your consent',
        run: () => this.setup(),
      });
      items.push({
        label: '$(gear) Choose a Python interpreter',
        description: 'ifcViewer.engine.python',
        run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'ifcViewer.engine.python'),
      });
    }
    items.push({ label: '$(settings) Engine mode', description: this.settings().engine.mode, run: () => this.selectMode() });
    items.push({ label: '$(output) Show log', run: () => this.output.show(true) });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: state?.detail ?? 'IFC Viewer engine',
    });
    await picked?.run();
  }

  async selectMode(): Promise<void> {
    const current = this.settings().engine.mode;
    const picked = await vscode.window.showQuickPick(
      (Object.keys(MODE_LABELS) as EngineMode[]).map((mode) => ({
        label: MODE_LABELS[mode].label,
        description: MODE_LABELS[mode].description,
        detail: mode === current ? 'Current' : undefined,
        mode,
      })),
      { placeHolder: 'How should the IFC Viewer use IfcOpenShell?' },
    );
    if (picked) await this.setMode(picked.mode);
  }

  private async setMode(mode: EngineMode): Promise<void> {
    await vscode.workspace.getConfiguration('ifcViewer').update('engine.mode', mode, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('Reopen your IFC files for the engine setting to take effect.');
  }

  async dispose(): Promise<void> {
    for (const sub of this.subscriptions) sub.dispose();
    await this.manager.dispose();
  }
}
