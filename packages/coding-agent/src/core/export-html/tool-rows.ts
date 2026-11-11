/**
 * The reason and purpose rows a tool call shows, which the HTML export draws as the terminal does. They are terminal
 * components of the native feature set, so the session layer cannot import them: the composition installs a loader
 * here. Without one (a host built without the native features) the export has no such rows.
 */

import type { ToolRowView } from "./tool-renderer.ts";

export interface ExportToolRows {
	reasonRow: ToolRowView;
	purposeRows: ToolRowView;
}

const NO_ROWS: ExportToolRows = { reasonRow: () => undefined, purposeRows: () => undefined };

let loader: (() => Promise<ExportToolRows>) | undefined;

/** Sets how the export loads the rows; loaded on first export, since headless sessions rarely export. */
export function installExportToolRows(load: () => Promise<ExportToolRows>): void {
	loader = load;
}

/** The installed rows, or none. */
export function loadExportToolRows(): Promise<ExportToolRows> {
	return loader ? loader() : Promise.resolve(NO_ROWS);
}
