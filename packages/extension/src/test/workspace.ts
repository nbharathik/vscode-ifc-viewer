// A throwaway workspace folder for the extension-host suite: a copy of
// small.ifc under models/, so bridge tests can write .ifc-skills/ freely.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function makeTestWorkspace(fixturesDir: string): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ifc-bridge-ws-'));
  fs.mkdirSync(path.join(workspace, 'models'));
  fs.copyFileSync(path.join(fixturesDir, 'small.ifc'), path.join(workspace, 'models', 'small.ifc'));
  return workspace;
}
