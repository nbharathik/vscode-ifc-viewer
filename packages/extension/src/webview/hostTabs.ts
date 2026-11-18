// The Agent and Engine tabs of the viewer's sidebar. The viewer core knows
// nothing about the editor, the agent bridge or IfcOpenShell, so these tabs are
// built here from what the host reports and are plain DOM over the core's tab
// API. Buttons reuse the core's View tab styling.
import type { SessionState, SidebarTabHandle, Viewer } from '@vscode-ifc-viewer/core';
import type { AgentStatus, WebviewCommand, WebviewToHost } from '../protocol.js';

type Post = (message: WebviewToHost) => void;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A titled group inside a tab, matching the View tab's look. */
function group(title: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('section', 'ifc-viewtab__group');
  const body = el('div', 'ifc-viewtab__body');
  root.append(el('div', 'ifc-menu__label', title), body);
  return { root, body };
}

function note(text: string, testId?: string): HTMLElement {
  const p = el('div', 'ifc-host-note', text);
  if (testId) p.setAttribute('data-testid', testId);
  return p;
}

function button(testId: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', undefined, label);
  btn.type = 'button';
  btn.setAttribute('data-testid', testId);
  btn.addEventListener('click', onClick);
  return btn;
}

function mountBody(tab: SidebarTabHandle): HTMLElement {
  const root = el('div', 'ifc-tab ifc-viewtab');
  const scroll = el('div', 'ifc-panel__body');
  root.appendChild(scroll);
  tab.body.appendChild(root);
  return scroll;
}

/** What the Engine tab says for each session state. */
export function describeEngine(state: SessionState): { headline: string; detail: string } {
  switch (state.state) {
    case 'ready':
      return {
        headline: 'IfcOpenShell is active',
        detail: 'Properties and edits come from the live model. Edits stay unsaved until you save the file.',
      };
    case 'starting':
      return {
        headline: 'IfcOpenShell is starting',
        detail: 'The model is already viewable; editing becomes available shortly.',
      };
    case 'idle':
      return {
        headline: 'Read-only for now',
        detail: 'IfcOpenShell starts when you first edit a value, or when you press the button below.',
      };
    case 'unavailable':
      return {
        headline: 'Read-only (web-ifc)',
        detail: state.detail ?? 'IfcOpenShell is not available.',
      };
    default:
      return {
        headline: 'Read-only (web-ifc)',
        detail: 'IfcOpenShell is turned off (setting ifcViewer.engine.mode).',
      };
  }
}

export class HostTabs {
  private readonly engineStatus = el('div', 'ifc-host-status');
  private readonly engineDetail = note('', 'engine-detail');
  private readonly startBtn: HTMLButtonElement;
  private readonly setupBtn: HTMLButtonElement;
  private readonly engineTab: SidebarTabHandle | null;

  private readonly agentStatus = el('div', 'ifc-host-status');
  private readonly agentDetail = note('', 'agent-detail');
  private readonly toggleBtn: HTMLButtonElement;
  private readonly changeNote = note('', 'agent-changes');
  private readonly clearBtn: HTMLButtonElement;
  private agentTab: SidebarTabHandle | null = null;
  private agentBody: HTMLElement | null = null;

  constructor(
    private readonly viewer: Viewer,
    private readonly post: Post,
    private readonly onClearChanges: () => void,
  ) {
    this.engineStatus.setAttribute('data-testid', 'engine-state');
    this.agentStatus.setAttribute('data-testid', 'agent-state');
    this.startBtn = button('engine-start', 'Start editing engine', () => this.post({ type: 'startSession' }));
    this.setupBtn = button('engine-setup', 'Set up IfcOpenShell', () => this.run('setupIfcOpenShell'));
    this.toggleBtn = button('agent-toggle', 'Connect to agent', () => this.post({ type: 'agentToggle' }));
    this.clearBtn = button('agent-clear', 'Clear highlight', () => this.onClearChanges());

    this.engineTab = this.viewer.addSidebarTab({ id: 'engine', label: 'Engine', order: 50 });
    if (this.engineTab) this.buildEngine(this.engineTab);
  }

  private run(command: WebviewCommand): void {
    this.post({ type: 'command', command });
  }

  // -- engine --------------------------------------------------------------

  private buildEngine(tab: SidebarTabHandle): void {
    const scroll = mountBody(tab);
    const status = group('IfcOpenShell');
    status.body.append(this.engineStatus, this.engineDetail, this.startBtn, this.setupBtn);
    const more = group('Engine');
    more.body.append(
      button('engine-choose', 'Choose engine', () => this.run('selectEngine')),
      button('engine-log', 'Show log', () => this.run('showLog')),
    );
    scroll.append(status.root, more.root);
    this.setSession({ state: 'unavailable', engine: 'web-ifc', canQuery: false, canEdit: false });
  }

  setSession(state: SessionState): void {
    const { headline, detail } = describeEngine(state);
    this.engineHeadline = headline;
    this.engineStatus.textContent = headline;
    this.engineDetail.textContent = detail;
    this.startBtn.hidden = state.state !== 'idle';
    this.setupBtn.hidden = state.state !== 'unavailable';
    this.engineTab?.setBadge(state.state === 'ready' ? 'on' : null);

    // Opening a large model takes a while and the server cannot report
    // fractions, so show that it is working and for how long.
    if (state.state === 'starting') {
      if (this.startingSince === null) {
        this.startingSince = Date.now();
        this.ticker = window.setInterval(() => this.tick(), 1000);
      }
      this.tick();
    } else {
      this.startingSince = null;
      if (this.ticker !== null) window.clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private engineHeadline = '';
  private startingSince: number | null = null;
  private ticker: number | null = null;

  private tick(): void {
    if (this.startingSince === null) return;
    const seconds = Math.floor((Date.now() - this.startingSince) / 1000);
    this.engineStatus.textContent = `${this.engineHeadline} (${seconds} s)`;
  }

  // -- agent ---------------------------------------------------------------

  /** Create the Agent tab on the first "available" status; remove it when the bridge goes away. */
  setAgent(agent: AgentStatus): void {
    if (!agent.available) {
      this.agentTab?.remove();
      this.agentTab = null;
      this.agentBody = null;
      return;
    }
    if (!this.agentTab) {
      this.agentTab = this.viewer.addSidebarTab({ id: 'agent', label: 'Agent', order: 40 });
      if (this.agentTab) this.buildAgent(this.agentTab);
    }
    const where = agent.folderName ? ` for "${agent.folderName}"` : '';
    if (agent.blockedReason) {
      this.agentStatus.textContent = 'Not available';
      this.agentDetail.textContent = agent.blockedReason;
    } else if (agent.connected) {
      this.agentStatus.textContent = `Connected${where}`;
      this.agentDetail.textContent =
        'Your agent can see the selection and highlight elements. Run python .ifc-skills/viewer/ifc_live.py repl to work on the live model.';
    } else {
      this.agentStatus.textContent = 'Not connected';
      this.agentDetail.textContent = `Connecting${where} lets an AI agent see your selection and highlight elements (writes .ifc-skills/viewer/).`;
    }
    this.toggleBtn.textContent = agent.connected ? 'Disconnect' : 'Connect to agent';
    this.toggleBtn.disabled = Boolean(agent.blockedReason);
  }

  private buildAgent(tab: SidebarTabHandle): void {
    const scroll = mountBody(tab);
    this.agentBody = scroll;
    const connection = group('Connection');
    connection.body.append(this.agentStatus, this.agentDetail, this.toggleBtn);
    const access = group('Access');
    access.body.append(
      button('agent-instructions', 'Add agent instructions', () => this.run('addAgentInstructions')),
      button('agent-tools', 'Add agent tools (MCP)', () => this.run('addAgentTools')),
    );
    const changes = group('Changed by agent');
    changes.body.append(this.changeNote, this.clearBtn);
    scroll.append(connection.root, access.root, changes.root);
    this.setChanges(0);
  }

  /** Elements an agent edited in this session. */
  setChanges(count: number, highlighted = false): void {
    const plural = `${count} element${count === 1 ? '' : 's'} changed`;
    this.changeNote.textContent =
      count === 0
        ? 'No edits by an agent yet.'
        : highlighted
          ? `${plural}, shown in amber.`
          : `${plural}. Turn on ifcViewer.engine.highlightAgentEdits in Settings to show them in amber.`;
    this.clearBtn.hidden = count === 0 || !highlighted;
    this.agentTab?.setBadge(count > 0 ? String(count) : null);
  }

  /** The tab body is only built once an agent is available. */
  hasAgentTab(): boolean {
    return this.agentBody !== null;
  }
}
