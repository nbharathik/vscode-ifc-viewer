// Entry for @vscode/test-electron: downloads a VS Code build and runs the mocha
// suite inside the extension host. On CI this runs under xvfb (Linux).
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // Inherited from Electron-based terminals (IDE integrations); makes the
  // spawned Code.exe run as plain Node, which rejects every launch flag.
  delete process.env.ELECTRON_RUN_AS_NODE;

  // packages/extension (contains package.json with the extension manifest).
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  // Repo root, so the suite can find committed fixtures.
  const repoRoot = path.resolve(__dirname, '../../../..');

  // VSCODE_VERSION lets CI/dev pick 'stable' | 'insiders' | a pinned version.
  // (On a dev box where stable VS Code is mid-update, 'insiders' avoids the
  // shared Inno Setup update mutex that blocks launching the downloaded build.)
  const version = process.env.VSCODE_VERSION || 'stable';

  await runTests({
    version,
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: { IFC_FIXTURES: path.join(repoRoot, 'fixtures') },
    launchArgs: ['--disable-extensions', '--disable-gpu'],
  });
}

main().catch((err) => {
  console.error('Failed to run extension tests:', err);
  process.exit(1);
});
