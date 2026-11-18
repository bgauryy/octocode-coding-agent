import { reasonRow } from "../../../../octocode/ui/reason-row.ts";

/** Arguments as comparable text; undefined when they cannot be serialized, which always redraws. */
export function argsKey(args: unknown): string | undefined {
	try {
		return JSON.stringify(args);
	} catch {
		return undefined;
	}
}

/** Whether expanding a row shows more: any output, or call details only the expanded row lists. */
export function hasHiddenContent(row: { hasResult: boolean; generic: boolean; toolName: string; args: any }): boolean {
	if (row.hasResult) return true;
	const { toolName, args } = row;
	if (row.generic && args !== undefined && args !== null && Object.keys(args).length > 0) return true;
	const drawn = (expanded: boolean) => reasonRow(toolName, args, undefined, expanded)?.render(80).join("\n");
	return drawn(true) !== drawn(false);
}
