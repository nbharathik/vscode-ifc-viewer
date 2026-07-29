// Mocha runner loaded inside the extension host by @vscode/test-electron.
import * as path from 'path';
import { readdirSync } from 'fs';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 60000 });
  const testsRoot = __dirname;

  return new Promise((resolve, reject) => {
    try {
      for (const file of readdirSync(testsRoot)) {
        if (file.endsWith('.test.js')) {
          mocha.addFile(path.resolve(testsRoot, file));
        }
      }
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}
