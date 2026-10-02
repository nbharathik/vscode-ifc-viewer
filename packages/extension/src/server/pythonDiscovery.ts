// Find a Python that can import IfcOpenShell. Pure: the process runner is
// injected, so the candidate order and the probe parsing are unit-tested.

export interface PythonCandidate {
  command: string;
  args: string[];
  /** Where the candidate came from, for diagnostics. */
  source: string;
}

export interface PythonInfo extends PythonCandidate {
  version: string;
  ifcopenshell: string;
}

export interface Probe {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type ProbeRunner = (command: string, args: string[]) => Promise<Probe>;

export type Discovery =
  | { ok: true; python: PythonInfo }
  | { ok: false; reason: 'no-python' | 'no-ifcopenshell' | 'old-ifcopenshell'; message: string; tried: string[] };

export const MIN_IFCOPENSHELL = [0, 8, 4] as const;
const PROBE_CODE = 'import sys,ifcopenshell;print(sys.version.split()[0]);print(ifcopenshell.version)';

/** Candidates in priority order: explicit setting, managed venv, then PATH names. */
export function candidates(options: {
  setting: string;
  managedPython: string | null;
  platform: NodeJS.Platform;
}): PythonCandidate[] {
  const list: PythonCandidate[] = [];
  const setting = options.setting.trim();
  if (setting) list.push({ command: setting, args: [], source: 'setting ifcViewer.python' });
  if (options.managedPython) {
    list.push({ command: options.managedPython, args: [], source: 'extension-managed environment' });
  }
  if (options.platform === 'win32') {
    list.push({ command: 'py', args: ['-3'], source: 'py launcher' });
    list.push({ command: 'python', args: [], source: 'PATH' });
  } else {
    list.push({ command: 'python3', args: [], source: 'PATH' });
    list.push({ command: 'python', args: [], source: 'PATH' });
  }
  return list;
}

/** "0.8.4.post1" -> [0, 8, 4]; null when it does not look like a version. */
export function parseVersion(text: string): number[] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

export function atLeast(version: number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    const a = version[i] ?? 0;
    if (a !== minimum[i]) return a > minimum[i];
  }
  return true;
}

export function belowMajorMinor(version: number[], limit: readonly [number, number]): boolean {
  return version[0] > limit[0] || (version[0] === limit[0] && version[1] >= limit[1]);
}

export async function discoverPython(list: PythonCandidate[], run: ProbeRunner): Promise<Discovery> {
  const tried: string[] = [];
  let sawPython = false;
  let sawOld: string | null = null;
  for (const candidate of list) {
    const label = [candidate.command, ...candidate.args].join(' ');
    tried.push(`${label} (${candidate.source})`);
    const probe = await run(candidate.command, [...candidate.args, '-c', PROBE_CODE]);
    if (!probe.ok) {
      // Python itself starts but IfcOpenShell is missing: ModuleNotFoundError.
      if (/No module named/i.test(probe.stderr) || /ModuleNotFoundError/i.test(probe.stderr)) sawPython = true;
      continue;
    }
    sawPython = true;
    const [pythonVersion, ifcVersion] = probe.stdout.trim().split(/\r?\n/);
    const parsed = parseVersion(ifcVersion ?? '');
    if (!parsed) continue;
    if (!atLeast(parsed, MIN_IFCOPENSHELL) || belowMajorMinor(parsed, [0, 9])) {
      sawOld = ifcVersion;
      continue;
    }
    return {
      ok: true,
      python: { ...candidate, version: pythonVersion ?? '', ifcopenshell: ifcVersion },
    };
  }
  if (sawOld) {
    return {
      ok: false,
      reason: 'old-ifcopenshell',
      message: `IfcOpenShell ${sawOld} is installed, but the viewer needs 0.8.4 or newer and below 0.9.`,
      tried,
    };
  }
  if (sawPython) {
    return {
      ok: false,
      reason: 'no-ifcopenshell',
      message: 'Python was found, but it does not have IfcOpenShell (pip install "ifcopenshell>=0.8.4,<0.9").',
      tried,
    };
  }
  return { ok: false, reason: 'no-python', message: 'No Python 3 was found.', tried };
}
