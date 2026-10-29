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
.ifc-panel__body {
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
.ifc-table td.ifc-val--editable { cursor: text; }
.ifc-table td.ifc-val--editable:hover {
  background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 14%, transparent);
}
.ifc-table td.ifc-val--enable { cursor: pointer; }
.ifc-table td.ifc-val--enable:hover {
  background: color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 10%, transparent);
  text-decoration: underline dotted;
}
.ifc-table td.ifc-edit-failed { outline: 1px solid var(--vscode-inputValidation-errorBorder, #be1100); }
.ifc-edit-input {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-focusBorder, #3794ff);
  border-radius: 2px;
  padding: 1px 4px;
}
.ifc-edit-invalid { border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
.ifc-unit { opacity: 0.65; font-weight: normal; }
.ifc-notice {
  margin: 0 0 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  white-space: pre-wrap;
  word-break: break-word;
}
.ifc-table td.ifc-row-actions { width: 18px; padding: 0; text-align: center; }
.ifc-row-remove {
  visibility: hidden;
  padding: 0 4px;
  font: inherit;
  line-height: 1;
  background: transparent;
  color: inherit;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  opacity: 0.7;
}
.ifc-table tr:hover .ifc-row-remove,
.ifc-row-remove:focus-visible { visibility: visible; }
.ifc-row-remove:hover { opacity: 1; background: var(--vscode-list-hoverBackground, #2a2d2e); }
.ifc-add { margin: 2px 0 4px; }
.ifc-add--pset { margin-top: 10px; }
.ifc-add__open {
  font: inherit;
  font-size: 11px;
  background: transparent;
  color: var(--vscode-textLink-foreground, #3794ff);
  border: none;
  padding: 2px 0;
  cursor: pointer;
}
.ifc-add__open:hover { text-decoration: underline; }
.ifc-add__form { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.ifc-add__form input,
.ifc-add__form select {
  flex: 1 1 70px;
  min-width: 0;
  font: inherit;
  font-size: 11px;
  padding: 2px 4px;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
}
.ifc-add__form select { flex: 0 0 auto; }
.ifc-add__form button {
  font: inherit;
  font-size: 11px;
  padding: 2px 8px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #fff);
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
}
.ifc-add__form button[type="submit"] {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
}

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
.ifc-tools__toggle:hover:not(:disabled) { filter: brightness(1.15); }
.ifc-tools__toggle:disabled { opacity: 0.45; cursor: default; }
.ifc-tools__toggle svg { width: 16px; height: 16px; display: block; }
.ifc-tools__toggle[data-active="true"] {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
}
/* Keyboard focus has to be visible. */
.ifc-tools__toggle:focus-visible,
.ifc-viewtab button:focus-visible,
.ifc-viewtab input:focus-visible,
.ifc-sidebar__tab:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #0078d4);
  outline-offset: 1px;
}
.ifc-shelf-hidden .ifc-tools { display: none; }
/* Sidebar: header title and collapse, a tab strip, then the active tab. */
.ifc-sidebar__tabs {
  display: flex;
  flex: 0 0 auto;
  border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
}
.ifc-sidebar__tab {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font: inherit;
  font-size: 11px;
  padding: 6px 2px;
  background: transparent;
  color: inherit;
  border: none;
  border-bottom: 2px solid transparent;
  opacity: 0.7;
  cursor: pointer;
}
.ifc-sidebar__tab:hover { opacity: 1; background: var(--vscode-list-hoverBackground, #2a2d2e); }
.ifc-sidebar__tab[aria-selected="true"] {
  opacity: 1;
  border-bottom-color: var(--vscode-focusBorder, #0078d4);
}
.ifc-sidebar__badge {
  font-size: 9px;
  line-height: 1;
  padding: 1px 4px;
  border-radius: 8px;
  background: var(--vscode-badge-background, #4d4d4d);
  color: var(--vscode-badge-foreground, #fff);
}
.ifc-sidebar__badge[hidden] { display: none; }
.ifc-sidebar__bodies { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.ifc-sidebar__body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.ifc-sidebar__body[hidden] { display: none; }
.ifc-tab { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
/* View tab controls. */
.ifc-viewtab__group { margin-bottom: 12px; }
.ifc-viewtab__body { display: flex; flex-direction: column; gap: 4px; }
.ifc-viewtab__grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; }
.ifc-viewtab__sub { font-size: 11px; opacity: 0.75; margin: 2px 2px 0; }
.ifc-viewtab button {
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
.ifc-viewtab button:hover:not(:disabled) { filter: brightness(1.15); }
.ifc-viewtab button:disabled { opacity: 0.45; cursor: default; }
.ifc-viewtab button[aria-pressed="true"] {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
}
.ifc-viewtab__group .ifc-menu__label { display: flex; align-items: center; gap: 6px; }
.ifc-viewtab button[hidden] { display: none; }
/* Text blocks in host-supplied tabs (Agent, Engine). */
.ifc-host-status { font-weight: 600; }
.ifc-host-note { opacity: 0.8; line-height: 1.4; overflow-wrap: anywhere; }
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

/* Highlight legend: bottom-left, following the tree edge like the toolbar. */
.ifc-legend {
  position: absolute;
  left: 296px;
  bottom: 8px;
  width: 220px;
  max-height: 40%;
  display: none;
  flex-direction: column;
  background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-editor-foreground, #ccc);
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  border-radius: 6px;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 11px;
  z-index: 6;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.ifc-tree-hidden .ifc-legend { left: 46px; }
.ifc-legend--visible { display: flex; }
.ifc-legend__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 4px 10px;
  font-weight: 600;
  border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
}
.ifc-legend__clear-all {
  font: inherit;
  font-weight: normal;
  background: transparent;
  color: inherit;
  border: none;
  border-radius: 3px;
  padding: 2px 6px;
  cursor: pointer;
  opacity: 0.8;
}
.ifc-legend__list {
  padding: 4px 6px;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4)) transparent;
}
.ifc-legend__row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 2px 4px;
}
.ifc-legend__swatch {
  flex: 0 0 10px;
  height: 10px;
  border-radius: 2px;
  border: 1px solid rgba(0, 0, 0, 0.35);
}
.ifc-legend__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ifc-legend__count { flex: 0 0 auto; opacity: 0.7; }
.ifc-legend__clear {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  color: inherit;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  opacity: 0.7;
}
.ifc-legend__clear svg { width: 11px; height: 11px; display: block; }
.ifc-legend__clear:hover,
.ifc-legend__clear-all:hover { opacity: 1; background: var(--vscode-list-hoverBackground, #2a2d2e); }
.ifc-legend__clear:focus-visible,
.ifc-legend__clear-all:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #0078d4);
  opacity: 1;
}

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
/* Status bar along the bottom edge; floating panels rise above it. */
.ifc-status {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 8px;
  box-sizing: border-box;
  background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-editor-foreground, #cccccc);
  border-top: 1px solid var(--vscode-widget-border, #3c3c3c);
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 11px;
  z-index: 7;
}
.ifc-status__side { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ifc-status__side--right { justify-content: flex-end; flex: 0 0 auto; }
.ifc-status__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 40ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}
.ifc-status__item[hidden] { display: none; }
button.ifc-status__item {
  font: inherit;
  color: inherit;
  background: transparent;
  border: none;
  border-radius: 3px;
  padding: 1px 4px;
  cursor: pointer;
}
button.ifc-status__item:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, #2a2d2e); opacity: 1; }
button.ifc-status__item:focus-visible { outline: 1px solid var(--vscode-focusBorder, #0078d4); outline-offset: -1px; opacity: 1; }
button.ifc-status__item:disabled { cursor: default; opacity: 0.5; }
.ifc-status__item[data-active="true"] { opacity: 1; color: var(--vscode-textLink-foreground, #3794ff); }
.ifc-status__icon { display: inline-flex; }
.ifc-status__icon svg { width: 12px; height: 12px; display: block; }
.ifc-has-status .ifc-panel,
.ifc-has-status .ifc-legend,
.ifc-has-status .ifc-perf { bottom: 30px; }
/* Orientation gizmo: top right of the viewport, left of the sidebar. */
.ifc-gizmo {
  position: absolute;
  top: 8px;
  right: 296px;
  width: 84px;
  height: 84px;
  z-index: 5;
}
.ifc-props-hidden .ifc-gizmo { right: 46px; }
.ifc-gizmo svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.ifc-gizmo__axis {
  position: absolute;
  width: 20px;
  height: 20px;
  margin: -10px 0 0 -10px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: var(--axis, #888);
  border: 1px solid rgba(0, 0, 0, 0.35);
  border-radius: 50%;
  cursor: pointer;
}
.ifc-gizmo__axis--neg {
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  background: color-mix(in srgb, var(--axis, #888) 45%, transparent);
}
.ifc-gizmo__axis:hover { filter: brightness(1.2); }
.ifc-gizmo__axis:focus-visible { outline: 1px solid var(--vscode-focusBorder, #0078d4); outline-offset: 1px; }
/* Right-click menu. */
.ifc-ctx {
  position: absolute;
  z-index: 15;
  min-width: 190px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
  color: var(--vscode-menu-foreground, var(--vscode-editor-foreground, #cccccc));
  border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, #3c3c3c));
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 12px;
}
.ifc-ctx[hidden] { display: none; }
.ifc-ctx__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  font: inherit;
  text-align: left;
  padding: 4px 10px;
  background: transparent;
  color: inherit;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.ifc-ctx__item:hover:not(:disabled),
.ifc-ctx__item:focus-visible {
  outline: none;
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, #04395e));
  color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground, #ffffff));
}
.ifc-ctx__item:disabled { opacity: 0.45; cursor: default; }
/* Command search. */
.ifc-cmd {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 10%;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 13px;
}
.ifc-cmd[hidden] { display: none; }
.ifc-cmd__box {
  width: min(560px, calc(100% - 32px));
  max-height: 60%;
  display: flex;
  flex-direction: column;
  background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, #252526));
  color: var(--vscode-quickInput-foreground, var(--vscode-editor-foreground, #cccccc));
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  border-radius: 6px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.ifc-cmd__input {
  flex: 0 0 auto;
  margin: 8px;
  font: inherit;
  padding: 5px 8px;
  border-radius: 3px;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #cccccc);
  border: 1px solid var(--vscode-input-border, transparent);
}
.ifc-cmd__input:focus-visible { outline: 1px solid var(--vscode-focusBorder, #0078d4); outline-offset: -1px; }
.ifc-cmd__list { overflow: auto; padding: 0 0 6px; }
.ifc-cmd__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 12px;
  cursor: pointer;
}
.ifc-cmd__item[aria-selected="true"] {
  background: var(--vscode-list-activeSelectionBackground, #04395e);
  color: var(--vscode-list-activeSelectionForeground, #ffffff);
}
.ifc-cmd__item[aria-disabled="true"] { opacity: 0.45; cursor: default; }
.ifc-cmd__item[data-checked="true"] .ifc-cmd__label::after { content: " (on)"; opacity: 0.7; }
.ifc-cmd__group { flex: 0 0 auto; min-width: 72px; opacity: 0.65; font-size: 11px; }
.ifc-cmd__label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ifc-cmd__key {
  flex: 0 0 auto;
  font: inherit;
  font-size: 11px;
  padding: 0 5px;
  border-radius: 3px;
  border: 1px solid var(--vscode-widget-border, #3c3c3c);
  opacity: 0.8;
}
.ifc-cmd__empty { padding: 8px 12px; opacity: 0.7; }
`;

export function ensurePanelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
