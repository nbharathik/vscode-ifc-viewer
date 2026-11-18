// Optional setup: create a private Python environment in the extension's
// storage and install IfcOpenShell into it, after the user agrees. Nothing
// is bundled in the extension (IfcOpenShell is LGPL-3.0, the extension MIT),
// and nothing is installed into the user's own Python.
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { managedPythonPath } from './serverManager.js';
import type { ServerManager } from './serverManager.js';

const REQUIREMENT = 'ifcopenshell>=0.8.4,<0.9';

function run(command: string, args: string[], output: vscode.OutputChannel): Promise<number> {
  return new Promise((resolve) => {
    output.appendLine(`$ ${[command, ...args].join(' ')}`);
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line) output.appendLine(line);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => {
      output.appendLine(String(err));
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/** A Python 3 on this machine that can create a venv, or null. */
async function findBasePython(output: vscode.OutputChannel): Promise<{ command: string; args: string[] } | null> {
  const options =
    process.platform === 'win32'
      ? [
          { command: 'py', args: ['-3'] },
          { command: 'python', args: [] },
        ]
      : [
          { command: 'python3', args: [] },
          { command: 'python', args: [] },
        ];
  for (const option of options) {
    if ((await run(option.command, [...option.args, '-c', 'import venv,sys;sys.exit(sys.version_info<(3,10))'], output)) === 0) {
      return option;
    }
  }
  return null;
}

/**
 * Create the managed environment and install IfcOpenShell. Resolves true when
 * the model server can start with it afterwards.
 */
export async function setupManagedPython(manager: ServerManager, output: vscode.OutputChannel): Promise<boolean> {
  const storage = manager.storagePath;
  const choice = await vscode.window.showInformationMessage(
    'Set up IfcOpenShell for the IFC Viewer?',
    {
      modal: true,
      detail:
        `This creates a private Python environment in the extension's storage (${path.join(storage, 'venv')}) ` +
        `and installs ${REQUIREMENT} from PyPI (about 60 MB). Your own Python is not changed. ` +
        'It enables editing, the live model and agent tools. You can remove the folder at any time.',
    },
    'Install',
  );
  if (choice !== 'Install') return false;

  output.show(true);
  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Setting up IfcOpenShell', cancellable: false },
    async (progress) => {
      const base = await findBasePython(output);
      if (!base) {
        void vscode.window.showErrorMessage('IFC Viewer: no Python 3.10 or newer was found. Install Python, then try again.');
        return false;
      }
      await fs.mkdir(storage, { recursive: true });
      const venv = path.join(storage, 'venv');
      progress.report({ message: 'Creating the environment' });
      if ((await run(base.command, [...base.args, '-m', 'venv', venv], output)) !== 0) {
        void vscode.window.showErrorMessage('IFC Viewer: could not create the Python environment. See the IFC Viewer output.');
        return false;
      }
      const python = managedPythonPath(storage);
      progress.report({ message: 'Installing IfcOpenShell' });
      if ((await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', REQUIREMENT, 'numpy'], output)) !== 0) {
        void vscode.window.showErrorMessage('IFC Viewer: installing IfcOpenShell failed. See the IFC Viewer output.');
        return false;
      }
      return true;
    },
  );
  if (!ok) return false;
  await manager.restart();
  const server = await manager.ensure();
  if (server) {
    void vscode.window.showInformationMessage('IfcOpenShell is ready. Reopen your IFC files to start editing.');
  }
  return server !== null;
}
