// Shared panel CSS, injected once per document. Colors come from VS Code theme
// CSS variables when present, and fall back to a neutral dark theme when they are
// absent. Light and dark follow those same variables.
const STYLE_ID = 'ifc-viewer-panel-styles';

const CSS = `
.ifc-panel {
  position: absolute;
  top: 8px;
  bottom: 8px;
  width: 280px;
  display: flex;
  flex-direction: column;
  background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-editor-foreground, #cccccc);
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  border-radius: 6px;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 12px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  z-index: 5;
}
.ifc-panel--right { right: 8px; }
.ifc-panel--left { left: 8px; }
.ifc-panel__header {
  padding: 8px 10px;
  font-weight: 600;
  border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
  background: var(--vscode-sideBarSectionHeader-background, #2d2d2d);
  flex: 0 0 auto;
}
.ifc-panel__body {
  padding: 8px 10px;
  overflow: auto;
  flex: 1 1 auto;
}
/* Thin, theme-matched scrollbars in every scrolling surface. */
.ifc-panel__body,
.ifc-stats__body,
.ifc-tools__menu {
  scrollbar-width: thin;
  scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4)) transparent;
}
.ifc-empty {
  opacity: 0.65;
  font-style: italic;
  padding: 8px 2px;
}
.ifc-section { margin-bottom: 12px; }
.ifc-section__title {
  font-weight: 600;
  margin: 6px 0 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ifc-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--vscode-badge-background, #4d4d4d);
  color: var(--vscode-badge-foreground, #fff);
  text-transform: uppercase;
}
.ifc-table { width: 100%; border-collapse: collapse; }
.ifc-table td {
  padding: 2px 4px;
  vertical-align: top;
  border-bottom: 1px solid var(--vscode-widget-border, #333);
  word-break: break-word;
}
.ifc-table td.ifc-key {
  opacity: 0.8;
  width: 45%;
  white-space: nowrap;
}
.ifc-table td.ifc-val { font-weight: 500; }
.ifc-null { opacity: 0.5; }

/* Spatial tree */
.ifc-tree-node { user-select: none; }
.ifc-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 2px;
  border-radius: 3px;
  cursor: default;
  white-space: nowrap;
}
.ifc-tree-row:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.ifc-tree-row--selected,
.ifc-tree-row--selected:hover {
  background: var(--vscode-list-activeSelectionBackground, #094771);
  color: var(--vscode-list-activeSelectionForeground, #fff);
}
.ifc-tree-toggle {
  width: 12px;
  flex: 0 0 12px;
  text-align: center;
  cursor: pointer;
  opacity: 0.85;
}
.ifc-tree-toggle--leaf { visibility: hidden; }
.ifc-tree-label {
  flex: 1 1 auto;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ifc-tree-type { opacity: 0.6; margin-left: 4px; font-size: 10px; }
.ifc-tree-eye {
  flex: 0 0 auto;
  cursor: pointer;
  opacity: 0.7;
  display: inline-flex;
  align-items: center;
}
.ifc-tree-eye svg { width: 13px; height: 13px; display: block; }
.ifc-tree-eye:hover { opacity: 1; }
.ifc-tree-node--hidden > .ifc-tree-row .ifc-tree-label { opacity: 0.4; }
.ifc-tree-children { margin-left: 12px; }

/* View-options menu (icon toggle beside the properties panel) */
.ifc-tools {
  position: absolute;
  top: 8px;
  right: 296px;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
}
.ifc-tools__toggle {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-editor-foreground, #ccc);
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  border-radius: 6px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
.ifc-tools__toggle:hover { filter: brightness(1.15); }
.ifc-tools__toggle svg { width: 16px; height: 16px; display: block; }
.ifc-tools__toggle[aria-expanded="true"] {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
}
.ifc-tools__menu {
  display: none;
  margin-top: 6px;
  flex-direction: column;
  gap: 4px;
  min-width: 120px;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  border-radius: 6px;
  padding: 6px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
}
.ifc-tools--open .ifc-tools__menu { display: flex; }
.ifc-tools__menu button {
  font: inherit;
  font-size: 11px;
  text-align: left;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ffffff);
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
}
.ifc-tools__menu button:hover { filter: brightness(1.15); }
.ifc-tools__menu button[aria-pressed="true"] {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
}

/* Statistics overlay */
.ifc-stats {
  position: absolute;
  left: 8px;
  bottom: 8px;
  width: 260px;
  max-height: 45%;
  display: none;
  flex-direction: column;
  background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-editor-foreground, #ccc);
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  border-radius: 6px;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 12px;
  z-index: 7;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.ifc-stats--visible { display: flex; }
.ifc-stats__header {
  padding: 6px 10px;
  font-weight: 600;
  border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ifc-stats__close { cursor: pointer; opacity: 0.7; }
.ifc-stats__close:hover { opacity: 1; }
.ifc-stats__body { padding: 6px 10px; overflow: auto; }

/* Loading overlay + error card */
.ifc-overlay {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 10;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  pointer-events: none;
}
.ifc-overlay--visible { display: flex; }
.ifc-loading-card {
  background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-editor-foreground, #cccccc);
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  border-radius: 8px;
  padding: 16px 22px;
  min-width: 220px;
  text-align: center;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4);
}
.ifc-loading-title { font-weight: 600; margin-bottom: 8px; }
.ifc-progress-track {
  height: 6px;
  border-radius: 3px;
  background: var(--vscode-progressBar-background, #3c3c3c);
  overflow: hidden;
  margin: 8px 0 6px;
}
.ifc-progress-fill {
  height: 100%;
  width: 0%;
  background: var(--vscode-progressBar-foreground, var(--vscode-button-background, #0e639c));
  transition: width 0.1s linear;
}
.ifc-loading-detail { font-size: 11px; opacity: 0.8; }
.ifc-error-card {
  pointer-events: auto;
  max-width: 460px;
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  color: var(--vscode-editor-foreground, #ffffff);
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  border-radius: 8px;
  padding: 16px 20px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
}
.ifc-error-title { font-weight: 600; margin-bottom: 6px; }
.ifc-error-message { font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.ifc-cancel-btn {
  pointer-events: auto;
  margin-top: 10px;
  font: inherit;
  font-size: 11px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ffffff);
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 3px 12px;
  cursor: pointer;
}
.ifc-cancel-btn:hover { filter: brightness(1.15); }

/* Performance HUD */
.ifc-perf {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 210px;
  display: none;
  background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-editor-foreground, #ccc);
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  border-radius: 6px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  z-index: 7;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  padding: 6px 10px;
}
.ifc-perf--visible { display: block; }
.ifc-perf__title {
  font-weight: 600;
  margin-bottom: 4px;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
}
.ifc-perf__row { display: flex; justify-content: space-between; padding: 1px 0; }
.ifc-perf__key { opacity: 0.75; }
`;

export function ensurePanelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
