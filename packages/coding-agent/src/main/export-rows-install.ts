/**
 * Side-effect import: lets the HTML export draw each tool call's reason and purpose rows, the core `bash` row and a
 * failed renderer's row, as the terminal does.
 */
import { installExportToolRows } from "../core/export-html/tool-rows.ts";

installExportToolRows(async () => {
	const [rows, { withBuiltInRenderers }, { callFallback, rendererFailure }] = await Promise.all([
		import("../octocode/ui/reason-row.ts"),
		import("../octocode/files/built-in-renderers.ts"),
		import("../modes/interactive/components/tool-execution/fallback.ts"),
	]);
	return {
		reasonRow: rows.reasonRow,
		purposeRows: rows.purposeRows,
		builtInRenderers: withBuiltInRenderers,
		callFailure: callFallback,
		resultFailure: rendererFailure,
	};
});
