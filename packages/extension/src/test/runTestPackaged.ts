// Runs the extension-host suite against a dist-only copy of the extension: the
// exact runtime payload of the .vsix (package.json + dist/ + media/, no src),
// to prove the packaged build still opens small.ifc.
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // Inherited from Electron-based terminals (IDE integrations); makes the
  // spawned Code.exe run as plain Node, which rejects every launch flag.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extRoot = path.resolve(__dirname, '../../'); // packages/extension
  const repoRoot = path.resolve(__dirname, '../../../..');

  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'ifc-vsix-'));
  fs.copyFileSync(path.join(extRoot, 'package.json'), path.join(staged, 'package.json'));
  fs.cpSync(path.join(extRoot, 'dist'), path.join(staged, 'dist'), { recursive: true });
  fs.cpSync(path.join(extRoot, 'media'), path.join(staged, 'media'), { recursive: true });

  await runTests({
    version: process.env.VSCODE_VERSION || 'stable',
    extensionDevelopmentPath: staged,
    extensionTestsPath: path.resolve(__dirname, './suite/index'),
    extensionTestsEnv: { IFC_FIXTURES: path.join(repoRoot, 'fixtures') },
    launchArgs: ['--disable-extensions', '--disable-gpu'],
  });
}

main().catch((err) => {
  console.error('Failed to run packaged extension tests:', err);
  process.exit(1);
});
