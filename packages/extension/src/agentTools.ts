// The agent's tools over the live model: look at what the user sees, point at
// elements, and read or edit the model held by IfcOpenShell. Everything runs
// through the same panels, sessions and validation as the viewer itself.
import * as vscode from 'vscode';
import { textResult } from './mcp/handler.js';
import type { ToolDef, ToolResult } from './mcp/handler.js';
import { summarizeChange } from './mcp/summary.js';
import type { ViewerPanel } from './ifcEditorProvider.js';
import type { BridgeAck, EditOp } from './protocol.js';

export type ResolvedTarget =
  | { ok: true; uri: vscode.Uri; panel: ViewerPanel | undefined; model: string }
  | { ok: false; error: string; model?: string };

/** What the tools need from the connected folder. Implemented by the bridge. */
export interface ToolHost {
  /** Validated viewer op (select, highlight, isolate, fit, clear, open, reload). */
  runViewerOp(fields: Record<string, unknown>): Promise<{ ack: BridgeAck; model?: string }>;
  resolveTarget(model: string | undefined): Promise<ResolvedTarget>;
  /** Open (or reveal) the model and wait until it is loaded. */
  ensurePanel(target: Extract<ResolvedTarget, { ok: true }>): Promise<ViewerPanel>;
  state(): unknown;
  scriptsAllowed(): boolean;
}

const OUTPUT_LIMIT = 20_000;

const MODEL_PROP = {
  type: 'string',
  description: 'Path of the .ifc file relative to the project root. Optional when exactly one model is open.',
};
const GLOBAL_IDS_PROP = {
  type: 'array',
  items: { type: 'string' },
  description: 'IFC GlobalIds. Storeys, buildings and aggregates expand to everything below them.',
};

function clip(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n... (${text.length - OUTPUT_LIMIT} more characters)` : text;
}

function asModel(args: Record<string, unknown>): string | undefined {
  return typeof args.model === 'string' && args.model.trim() ? args.model : undefined;
}

export function buildTools(host: ToolHost): ToolDef[] {
  const viewerOp = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = [],
  ): ToolDef => ({
    name,
    description,
    inputSchema: { type: 'object', properties: { model: MODEL_PROP, ...properties }, required },
    async run(args) {
      const { ack, model } = await host.runViewerOp({ ...args, op: name });
      return textResult({ ...ack, model }, !ack.ok);
    },
  });

  /** Panel with a ready editing session for `model`, or an explanation of why not. */
  async function liveSession(model: string | undefined) {
    const target = await host.resolveTarget(model);
    if (!target.ok) throw new Error(target.error);
    const panel = await host.ensurePanel(target);
    const session = panel.session;
    if (!session?.ready) {
      throw new Error(
        `Editing and queries need IfcOpenShell, which is not active for ${target.model}. ` +
          'Ask the user to click the engine icon in the viewer toolbar to set it up. Use the read-only tools meanwhile.',
      );
    }
    return { session, panel, model: target.model, uri: target.uri };
  }

  return [
    {
      name: 'get_state',
      description:
        'What the user has open in the IFC Viewer: models (path, loaded, unsaved changes, whether editing is available), ' +
        'the selected element (GlobalId, class, name) and the highlight groups on screen.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        return textResult(host.state());
      },
    },
    viewerOp(
      'open',
      'Open or reveal a model in the viewer without stealing focus. Resolves once it has loaded.',
      {},
      ['model'],
    ),
    viewerOp(
      'reload',
      'Re-read a model from disk, keeping camera, selection and highlights. Refused while the model has unsaved changes.',
      {},
      ['model'],
    ),
    viewerOp(
      'select',
      'Select the first of these elements in the viewer (tree and properties follow). Does not move the camera; use fit for that.',
      { globalIds: GLOBAL_IDS_PROP },
      ['globalIds'],
    ),
    viewerOp(
      'highlight',
      'Colour a named group of elements. The same label replaces its group. Show results with a short human label; it appears in the viewer legend.',
      {
        globalIds: GLOBAL_IDS_PROP,
        label: { type: 'string', description: 'Group name (default "agent").' },
        color: { type: 'string', description: '#rrggbb or a CSS colour name. Default: the next unused colour.' },
      },
      ['globalIds'],
    ),
    viewerOp('isolate', 'Hide everything except these elements.', { globalIds: GLOBAL_IDS_PROP }, ['globalIds']),
    viewerOp('fit', 'Frame these elements in the camera.', { globalIds: GLOBAL_IDS_PROP }, ['globalIds']),
    viewerOp(
      'clear',
      'Remove highlight groups, the isolate and/or the selection.',
      {
        what: { type: 'string', enum: ['highlight', 'isolate', 'selection', 'all'] },
        label: { type: 'string', description: 'With what=highlight, only this group.' },
      },
    ),
    {
      name: 'query',
      description:
        'Run a Python script against the live IfcOpenShell model the user sees (the same model that edits change). ' +
        'Predefined: model (ifcopenshell.file), ifcopenshell, api (ifcopenshell.api), element_util (ifcopenshell.util.element). ' +
        'print() results. Any edits the script makes become one undoable change in the viewer, highlighted for the user, ' +
        'and nothing is written to disk until the user saves. Answer from the model, never from memory.',
      inputSchema: {
        type: 'object',
        properties: {
          model: MODEL_PROP,
          code: { type: 'string', description: 'Python source.' },
          keepVariables: {
            type: 'boolean',
            description: 'Keep variables between calls and echo a lone expression, like an interactive prompt.',
          },
        },
        required: ['code'],
      },
      async run(args) {
        if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('"code" must be a non-empty string.');
        if (!host.scriptsAllowed()) {
          throw new Error('Scripts are turned off (setting ifcViewer.engine.allowScripts, or the workspace is not trusted).');
        }
        const { session, model } = await liveSession(asModel(args));
        const result = await session.query(args.code, 'agent-query', args.keepVariables === true);
        return textResult(
          {
            model,
            error: result.error,
            output: clip(result.output),
            ...summarizeChange(result.delta, result.patch),
          },
          result.error !== null,
        );
      },
    },
    {
      name: 'edit',
      description:
        'Apply typed edits to the live model in one undoable change, highlighted for the user and not saved until they save. ' +
        'Ops: setAttribute {globalId|id, name, value}; setProperty {globalId|id, pset, name, value}; removePset {globalId|id, psetId}; ' +
        'deleteProduct {globalId|id}; setPlacement {globalId|id, location:[x,y,z] metres}; assignContainer {globalId|id, containerId}; ' +
        'assignType {globalId|id, typeId}; createProduct {ifcClass, name, containerId, location}. ' +
        'For anything else use query with ifcopenshell.api. All ops apply or none do.',
      inputSchema: {
        type: 'object',
        properties: {
          model: MODEL_PROP,
          ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] } },
        },
        required: ['ops'],
      },
      async run(args) {
        if (!Array.isArray(args.ops) || args.ops.length === 0) throw new Error('"ops" must be a non-empty array.');
        const { session, model } = await liveSession(asModel(args));
        const result = await session.edit(args.ops as EditOp[], 'agent');
        return textResult({ model, ...summarizeChange(result.delta, result.patch) });
      },
    },
    {
      name: 'save',
      description:
        'Ask the user to save the model with unsaved changes to disk. The user is prompted and may decline.',
      inputSchema: { type: 'object', properties: { model: MODEL_PROP } },
      async run(args): Promise<ToolResult> {
        const { session, model, uri } = await liveSession(asModel(args));
        if (!session.dirty) return textResult({ model, saved: false, reason: 'There are no unsaved changes.' });
        const answer = await vscode.window.showWarningMessage(
          `An agent asks to save your changes to ${model}.`,
          { modal: true, detail: 'The file on disk will be overwritten with the edited model.' },
          'Save',
        );
        if (answer !== 'Save') return textResult({ model, saved: false, reason: 'The user declined.' }, true);
        const saved = await vscode.workspace.save(uri);
        return textResult({ model, saved: saved !== undefined });
      },
    },
  ];
}
