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
/* Each side panel hides independently via a container class; the toolbar
   follows the tree so it never covers it (see .ifc-tools below). */
.ifc-tree-hidden .ifc-panel--left { display: none; }
.ifc-props-hidden .ifc-panel--right { display: none; }
.ifc-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 6px 6px 10px;
  font-weight: 600;
  border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
  background: var(--vscode-sideBarSectionHeader-background, #2d2d2d);
  flex: 0 0 auto;
}
/* Collapse control embedded in the panel header, right-aligned. */
.ifc-panel__collapse {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  color: inherit;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.8;
}
.ifc-panel__collapse:hover {
  opacity: 1;
  background: var(--vscode-list-hoverBackground, #2a2d2e);
}
.ifc-panel__collapse:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #0078d4);
  outline-offset: 1px;
  opacity: 1;
}
.ifc-panel__collapse svg { width: 14px; height: 14px; display: block; }
/* A hidden panel leaves a small button on its edge as the way back. */
.ifc-panel-rail {
  position: absolute;
  top: 8px;
  z-index: 6;
  width: 30px;
  height: 30px;
  display: none;
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
.ifc-panel-rail:hover { filter: brightness(1.15); }
.ifc-panel-rail:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #0078d4);
  outline-offset: 1px;
}
.ifc-panel-rail svg { width: 16px; height: 16px; display: block; }
.ifc-panel-rail--left { left: 8px; }
.ifc-panel-rail--right { right: 8px; }
.ifc-tree-hidden .ifc-panel-rail--left { display: flex; }
.ifc-props-hidden .ifc-panel-rail--right { display: flex; }
/* Panel search row (spatial tree and properties). */
.ifc-panel__search {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
  flex: 0 0 auto;
}
.ifc-panel__search input {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  font-size: 11px;
  padding: 3px 6px;
  border-radius: 3px;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #cccccc);
  border: 1px solid var(--vscode-input-border, transparent);
}
.ifc-panel__search input:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #0078d4);
  outline-offset: -1px;
}
.ifc-panel__search input::placeholder {
  color: var(--vscode-input-placeholderForeground, #8a8a8a);
}
.ifc-search-clear {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  background: transparent;
  color: inherit;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  opacity: 0.75;
}
.ifc-search-clear:hover { opacity: 1; background: var(--vscode-list-hoverBackground, #2a2d2e); }
.ifc-search-clear:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #0078d4);
}
.ifc-search-count {
  flex: 0 0 auto;
  font-size: 10px;
  opacity: 0.75;
  white-space: nowrap;
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
/* Search mode: only matches and their revealed ancestors stay visible. Every
   node on the root-to-match path carries .ifc-tree-show, so nested display
   rules cannot hide a match behind a filtered ancestor. */
.ifc-tree--searching .ifc-tree-node:not(.ifc-tree-show) { display: none; }
.ifc-tree-row--match > .ifc-tree-label {
  color: var(--vscode-list-highlightForeground, #75beff);
  font-weight: 600;
}

/* Toolbar (icon buttons docked top-left, beside the spatial tree). It follows
   the tree edge so it never covers the tree, and slides to the viewport edge
   when the tree is hidden. */
.ifc-tools {
  position: absolute;
  top: 8px;
  left: 296px;
  z-index: 6;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 6px;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
}
/* With the tree hidden the toolbar slides left, leaving room for the
   tree's show button on the edge. */
.ifc-tree-hidden .ifc-tools { left: 46px; }
.ifc-tool { position: relative; }
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
.ifc-tools__toggle[aria-expanded="true"],
.ifc-tools__toggle[data-active="true"] {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
}
/* Keyboard focus has to be visible: these buttons are the only way back once
   the panels are hidden. */
.ifc-tools__toggle:focus-visible,
.ifc-tools__menu button:focus-visible,
.ifc-tools__menu input:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #0078d4);
  outline-offset: 1px;
}
.ifc-tools__menu {
  position: absolute;
  top: 36px;
  left: 0;
  display: none;
  flex-direction: column;
  gap: 4px;
  min-width: 150px;
  max-width: 230px;
  max-height: 60vh;
  overflow: auto;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  border-radius: 6px;
  padding: 6px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  z-index: 8;
}
.ifc-tool--open .ifc-tools__menu { display: flex; }
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
.ifc-tools__menu button:hover:not(:disabled) { filter: brightness(1.15); }
.ifc-tools__menu button:disabled { opacity: 0.45; cursor: default; }
.ifc-tools__menu button[aria-pressed="true"] {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
}
.ifc-menu__label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
  margin: 4px 2px 0;
}
.ifc-menu__sep {
  height: 1px;
  margin: 3px 0;
  background: var(--vscode-widget-border, #3c3c3c);
  flex: 0 0 auto;
}
.ifc-menu__row { display: flex; gap: 4px; }
.ifc-menu__row button { flex: 1 1 0; text-align: center; }
.ifc-menu__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4)) transparent;
}
.ifc-menu__empty { font-size: 11px; opacity: 0.65; font-style: italic; padding: 2px; }
.ifc-menu__slider {
  width: 100%;
  margin: 2px 0 4px;
  accent-color: var(--vscode-button-background, #0e639c);
}
.ifc-menu__slider:disabled { opacity: 0.45; }

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
