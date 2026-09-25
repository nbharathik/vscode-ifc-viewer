// Agent bridge file protocol: command validation, model path resolution and
// the state.json shape. Pure (Node `path` only, no `vscode`) so the rules an
// agent relies on are unit-tested directly.
import * as path from 'node:path';
import type { BridgeOp, ClearTarget, HighlightSummary, SelectionInfo } from './protocol.js';

export const PROTOCOL_VERSION = 1;
/** Bridge directory inside a workspace folder. */
export const BRIDGE_DIR = ['.ifc-skills', 'viewer'] as const;

export type InboxOp = 'open' | 'reload' | BridgeOp;
export const INBOX_OPS: readonly InboxOp[] = ['open', 'reload', 'select', 'highlight', 'isolate', 'fit', 'clear'];
const CLEAR_TARGETS: readonly ClearTarget[] = ['highlight', 'isolate', 'selection', 'all'];

/** A validated inbox command. */
export interface InboxCommand {
  id: string;
  op: InboxOp;
  createdAtMs: number;
  /** Workspace-relative or absolute path; optional for ops on the active model. */
  model?: string;
  globalIds?: string[];
  label?: string;
  color?: string;
  what?: ClearTarget;
}

export interface CommandLimits {
  nowMs: number;
  maxAgeMs: number;
  maxIds: number;
}

export type Validation =
  | { ok: true; command: InboxCommand }
  | { ok: false; id: string | null; error: string };

/** Command ids become outbox file names, so they may not contain separators. */
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
/** Commands dated this far in the future are rejected (clock skew allowance). */
const MAX_FUTURE_MS = 10_000;
const MAX_LABEL = 200;
const MAX_GLOBAL_ID = 64;

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id);
}

/**
 * Epoch milliseconds from a number (milliseconds, or seconds when below
 * 1e11, as Python's time.time() gives) or an ISO 8601 string.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

const OPS_WITH_IDS: readonly InboxOp[] = ['select', 'highlight', 'isolate', 'fit'];

export function validateCommand(raw: unknown, limits: CommandLimits): Validation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, id: null, error: 'The command must be a JSON object.' };
  }
  const c = raw as Record<string, unknown>;
  const id = isSafeId(c.id) ? c.id : null;
  const fail = (error: string): Validation => ({ ok: false, id, error });

  if (id === null) return fail('"id" must be 1-128 characters of A-Z, a-z, 0-9, ".", "_" or "-".');
  if (c.protocol !== PROTOCOL_VERSION) return fail(`"protocol" must be ${PROTOCOL_VERSION}.`);
  if (!INBOX_OPS.includes(c.op as InboxOp)) return fail(`"op" must be one of ${INBOX_OPS.join(', ')}.`);
  const op = c.op as InboxOp;

  const createdAtMs = parseTimestamp(c.createdAt);
  if (createdAtMs === null) return fail('"createdAt" must be epoch milliseconds or an ISO 8601 string.');
  const age = limits.nowMs - createdAtMs;
  if (age > limits.maxAgeMs) {
    return fail(`The command expired: created ${Math.round(age / 1000)} s ago (limit ${limits.maxAgeMs / 1000} s).`);
  }
  if (-age > MAX_FUTURE_MS) return fail('"createdAt" is in the future.');

  const command: InboxCommand = { id, op, createdAtMs };

  if (c.model !== undefined) {
    if (typeof c.model !== 'string' || !c.model.trim()) return fail('"model" must be a non-empty path.');
    command.model = c.model;
  } else if (op === 'open' || op === 'reload') {
    return fail(`"model" is required for "${op}".`);
  }

  if (c.globalIds !== undefined) {
    if (!Array.isArray(c.globalIds)) return fail('"globalIds" must be an array of strings.');
    if (c.globalIds.length > limits.maxIds) {
      return fail(`Too many GlobalIds: ${c.globalIds.length} (limit ${limits.maxIds}).`);
    }
    for (const g of c.globalIds) {
      if (typeof g !== 'string' || !g || g.length > MAX_GLOBAL_ID) {
        return fail('Every GlobalId must be a non-empty string of at most 64 characters.');
      }
    }
    command.globalIds = c.globalIds as string[];
  }
  if (OPS_WITH_IDS.includes(op) && !command.globalIds) return fail(`"globalIds" is required for "${op}".`);

  if (c.label !== undefined) {
    if (typeof c.label !== 'string' || c.label.length > MAX_LABEL) {
      return fail(`"label" must be a string of at most ${MAX_LABEL} characters.`);
    }
    command.label = c.label;
  }
  if (c.color !== undefined) {
    if (typeof c.color !== 'string') return fail('"color" must be a string such as "#e53935" or "red".');
    command.color = c.color;
  }
  if (c.what !== undefined) {
    if (!CLEAR_TARGETS.includes(c.what as ClearTarget)) {
      return fail(`"what" must be one of ${CLEAR_TARGETS.join(', ')}.`);
    }
    command.what = c.what as ClearTarget;
  }
  return { ok: true, command };
}

export type ModelPath = { ok: true; absolute: string; relative: string } | { ok: false; error: string };

/**
 * Resolve a command's model path inside `folder` (an absolute file-system
 * path). Accepts forward or back slashes, relative or absolute paths; the
 * result must stay inside the folder and name an .ifc file.
 */
export function resolveModelPath(folder: string, model: string, pathApi: typeof path = path): ModelPath {
  const cleaned = model.trim().replace(/[\\/]+/g, pathApi.sep);
  const absolute = pathApi.resolve(folder, cleaned);
  if (!isInside(folder, absolute, pathApi)) {
    return { ok: false, error: `"${model}" is outside the workspace folder.` };
  }
  if (!/\.ifc$/i.test(absolute)) return { ok: false, error: `"${model}" is not an .ifc file.` };
  return { ok: true, absolute, relative: toPosix(pathApi.relative(folder, absolute), pathApi) };
}

/** True when `child` (already resolved) is strictly inside `folder`. */
export function isInside(folder: string, child: string, pathApi: typeof path = path): boolean {
  const relative = pathApi.relative(folder, child);
  const escapes = relative === '..' || relative.startsWith(`..${pathApi.sep}`);
  return Boolean(relative) && !escapes && !pathApi.isAbsolute(relative);
}

export function toPosix(relative: string, pathApi: typeof path = path): string {
  return relative.split(pathApi.sep).join('/');
}

// -- state.json ------------------------------------------------------------

export interface ModelState {
  /** Workspace-relative, forward slashes. */
  path: string;
  active: boolean;
  fileMtimeMs: number | null;
  /** ISO 8601; null while the first load is still running. */
  loadedAt: string | null;
  isolated: boolean;
}

export interface BridgeState {
  protocol: typeof PROTOCOL_VERSION;
  viewer: { id: string; version: string; uriScheme: string };
  open: boolean;
  /** ISO 8601, refreshed every heartbeat. */
  heartbeatAt: string;
  heartbeatSeconds: number;
  models: ModelState[];
  selection: (SelectionInfo & { model: string })[];
  highlights: (HighlightSummary & { model: string })[];
  /** True when any open model shows an isolate. */
  isolated: boolean;
}

export interface PanelSnapshot {
  path: string;
  active: boolean;
  fileMtimeMs: number | null;
  loadedAtMs: number | null;
  selection: SelectionInfo | null;
  highlights: HighlightSummary[];
  isolated: boolean;
}

export function buildState(
  viewer: BridgeState['viewer'],
  panels: readonly PanelSnapshot[],
  options: { open: boolean; nowMs: number; heartbeatSeconds: number },
): BridgeState {
  const models = panels.map((p) => ({
    path: p.path,
    active: p.active,
    fileMtimeMs: p.fileMtimeMs,
    loadedAt: p.loadedAtMs === null ? null : new Date(p.loadedAtMs).toISOString(),
    isolated: p.isolated,
  }));
  return {
    protocol: PROTOCOL_VERSION,
    viewer,
    open: options.open,
    heartbeatAt: new Date(options.nowMs).toISOString(),
    heartbeatSeconds: options.heartbeatSeconds,
    models: options.open ? models : [],
    selection: options.open
      ? panels.flatMap((p) => (p.selection ? [{ model: p.path, ...p.selection }] : []))
      : [],
    highlights: options.open
      ? panels.flatMap((p) => p.highlights.map((h) => ({ model: p.path, ...h })))
      : [],
    isolated: options.open && panels.some((p) => p.isolated),
  };
}
