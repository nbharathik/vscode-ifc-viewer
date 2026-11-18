// Throwaway folders for the extension-host suite. The shared fixtures/ folder is
// easy to modify by accident (anyone opening small.ifc and saving an edit changes
// every later test run), so the suite generates its own pristine copies.
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Generate small.ifc, edge.ifc and house.ifc into a fresh temp folder with the
 * repo's fixture script. Falls back to the shared fixtures/ folder when Python
 * with IfcOpenShell is not available (those tests then still run, just on
 * whatever is in fixtures/).
 */
export function prepareFixtures(repoRoot: string): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ifc-fixtures-'));
  const script = path.join(repoRoot, 'scripts', 'build_fixtures.py');
  const candidates: [string, string[]][] =
    process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [command, args] of candidates) {
    const run = childProcess.spawnSync(command, [...args, script, '--out', out], { stdio: 'ignore', timeout: 60000 });
    if (run.status === 0 && fs.existsSync(path.join(out, 'small.ifc'))) return out;
  }
  return path.join(repoRoot, 'fixtures');
}

/** A workspace folder with a copy of small.ifc under models/, so tests can write .ifc-skills/ freely. */
export function makeTestWorkspace(fixturesDir: string): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ifc-bridge-ws-'));
  fs.mkdirSync(path.join(workspace, 'models'));
  fs.copyFileSync(path.join(fixturesDir, 'small.ifc'), path.join(workspace, 'models', 'small.ifc'));
  return workspace;
}
