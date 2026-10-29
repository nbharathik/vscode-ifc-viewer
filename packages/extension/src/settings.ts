// Extension settings: defaults and sanitizing. Pure (no `vscode`) so unit
// tests can check it, including that package.json declares the same defaults.

export type AutoConnect = 'never' | 'remember' | 'always';
export type AutoReloadMode = 'off' | 'whenConnected' | 'always';
export type EngineMode = 'auto' | 'web-ifc' | 'ifcopenshell';
/** When the IfcOpenShell session for a document starts. */
export type EngineStart = 'auto' | 'onOpen' | 'onDemand';

export interface ExtensionSettings {
  engine: {
    mode: EngineMode;
    start: EngineStart;
    maxFileSizeMb: number;
    scriptTimeoutSeconds: number;
    idleMinutes: number;
    python: string;
    allowScripts: boolean;
    highlightAgentEdits: boolean;
  };
  agentBridge: {
    mcpTools: boolean;
    enabled: boolean;
    autoConnect: AutoConnect;
    heartbeatSeconds: number;
    selectionDebounceMs: number;
    maxCommandAgeSeconds: number;
    maxIdsPerCommand: number;
    commandTimeoutSeconds: number;
    outboxRetentionMinutes: number;
    removeFolderOnDisconnect: boolean;
    revealHiddenCategories: boolean;
  };
  autoReload: {
    mode: AutoReloadMode;
    debounceMs: number;
    stabilityCheckMs: number;
    keepView: boolean;
  };
  highlightLegend: {
    visible: boolean;
  };
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  engine: {
    mode: 'auto',
    start: 'auto',
    maxFileSizeMb: 200,
    scriptTimeoutSeconds: 120,
    idleMinutes: 10,
    python: '',
    allowScripts: true,
    highlightAgentEdits: false,
  },
  agentBridge: {
    mcpTools: true,
    enabled: true,
    autoConnect: 'remember',
    heartbeatSeconds: 10,
    selectionDebounceMs: 150,
    maxCommandAgeSeconds: 60,
    maxIdsPerCommand: 50000,
    commandTimeoutSeconds: 120,
    outboxRetentionMinutes: 10,
    removeFolderOnDisconnect: true,
    revealHiddenCategories: true,
  },
  autoReload: {
    mode: 'whenConnected',
    debounceMs: 750,
    stabilityCheckMs: 300,
    keepView: true,
  },
  highlightLegend: {
    visible: true,
  },
};

/** Numeric bounds, mirrored by minimum/maximum in package.json. */
export const SETTING_BOUNDS: Record<string, [number, number]> = {
  'engine.maxFileSizeMb': [1, 100000],
  'engine.scriptTimeoutSeconds': [5, 3600],
  'engine.idleMinutes': [0, 1440],
  'agentBridge.heartbeatSeconds': [2, 300],
  'agentBridge.selectionDebounceMs': [0, 5000],
  'agentBridge.maxCommandAgeSeconds': [5, 3600],
  'agentBridge.maxIdsPerCommand': [1, 1000000],
  'agentBridge.commandTimeoutSeconds': [5, 3600],
  'agentBridge.outboxRetentionMinutes': [1, 1440],
  'autoReload.debounceMs': [100, 10000],
  'autoReload.stabilityCheckMs': [50, 5000],
};

/** Reads one setting by its dotted key under `ifcViewer.`; undefined when unset. */
export type SettingReader = (key: string) => unknown;

function bool(read: SettingReader, key: string, fallback: boolean): boolean {
  const value = read(key);
  return typeof value === 'boolean' ? value : fallback;
}

function num(read: SettingReader, key: string, fallback: number): number {
  const value = read(key);
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const [min, max] = SETTING_BOUNDS[key] ?? [-Infinity, Infinity];
  return Math.min(max, Math.max(min, value));
}

function oneOf<T extends string>(read: SettingReader, key: string, allowed: readonly T[], fallback: T): T {
  const value = read(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Settings from a reader, with wrong types replaced by defaults and numbers clamped. */
export function readSettings(read: SettingReader): ExtensionSettings {
  const d = DEFAULT_SETTINGS;
  const python = read('engine.python');
  return {
    engine: {
      mode: oneOf(read, 'engine.mode', ['auto', 'web-ifc', 'ifcopenshell'], d.engine.mode),
      start: oneOf(read, 'engine.start', ['auto', 'onOpen', 'onDemand'], d.engine.start),
      maxFileSizeMb: num(read, 'engine.maxFileSizeMb', d.engine.maxFileSizeMb),
      scriptTimeoutSeconds: num(read, 'engine.scriptTimeoutSeconds', d.engine.scriptTimeoutSeconds),
      idleMinutes: num(read, 'engine.idleMinutes', d.engine.idleMinutes),
      python: typeof python === 'string' ? python.trim() : d.engine.python,
      allowScripts: bool(read, 'engine.allowScripts', d.engine.allowScripts),
      highlightAgentEdits: bool(read, 'engine.highlightAgentEdits', d.engine.highlightAgentEdits),
    },
    agentBridge: {
      mcpTools: bool(read, 'agentBridge.mcpTools', d.agentBridge.mcpTools),
      enabled: bool(read, 'agentBridge.enabled', d.agentBridge.enabled),
      autoConnect: oneOf(read, 'agentBridge.autoConnect', ['never', 'remember', 'always'], d.agentBridge.autoConnect),
      heartbeatSeconds: num(read, 'agentBridge.heartbeatSeconds', d.agentBridge.heartbeatSeconds),
      selectionDebounceMs: num(read, 'agentBridge.selectionDebounceMs', d.agentBridge.selectionDebounceMs),
      maxCommandAgeSeconds: num(read, 'agentBridge.maxCommandAgeSeconds', d.agentBridge.maxCommandAgeSeconds),
      maxIdsPerCommand: num(read, 'agentBridge.maxIdsPerCommand', d.agentBridge.maxIdsPerCommand),
      commandTimeoutSeconds: num(read, 'agentBridge.commandTimeoutSeconds', d.agentBridge.commandTimeoutSeconds),
      outboxRetentionMinutes: num(read, 'agentBridge.outboxRetentionMinutes', d.agentBridge.outboxRetentionMinutes),
      removeFolderOnDisconnect: bool(read, 'agentBridge.removeFolderOnDisconnect', d.agentBridge.removeFolderOnDisconnect),
      revealHiddenCategories: bool(read, 'agentBridge.revealHiddenCategories', d.agentBridge.revealHiddenCategories),
    },
    autoReload: {
      mode: oneOf(read, 'autoReload.mode', ['off', 'whenConnected', 'always'], d.autoReload.mode),
      debounceMs: num(read, 'autoReload.debounceMs', d.autoReload.debounceMs),
      stabilityCheckMs: num(read, 'autoReload.stabilityCheckMs', d.autoReload.stabilityCheckMs),
      keepView: bool(read, 'autoReload.keepView', d.autoReload.keepView),
    },
    highlightLegend: {
      visible: bool(read, 'highlightLegend.visible', d.highlightLegend.visible),
    },
  };
}
