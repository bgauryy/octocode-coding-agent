/**
 * The reason and purpose rows a tool call shows, and the rows of a renderer that threw, which the HTML export draws as
 * the terminal does. They are terminal
 * components of the native feature set, so the session layer cannot import them: the composition installs a loader
 * here. Without one (a host built without the native features) the export has no such rows.
 */

import type { ToolRenderers } from "../features/types.ts";
import type { CallFailureView, ResultFailureView, ToolRowView } from "./tool-renderer.ts";

export interface ExportToolRows {
	reasonRow: ToolRowView;
	purposeRows: ToolRowView;
	/** A tool's renderers with the built-in ones (the core `bash` row) filled in where it supplies none, as the terminal draws it. */
	builtInRenderers?: (toolName: string, renderers: ToolRenderers | undefined) => ToolRenderers | undefined;
	/** The terminal's rows for a call or result renderer that threw. */
	callFailure?: CallFailureView;
	resultFailure?: ResultFailureView;
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
