import { hostReview, type McpReviewRating } from "./host.ts";
import { validateMcpServerConfig } from "./servers.ts";
import type { PastedDefinition } from "./add-parse.ts";
import type { McpFeatureState } from "./state.ts";
import type { McpUi } from "./ui.ts";

/** The host's static scan of each server about to be saved (pasted or typed field by field), or undefined when the host installed none: nothing runs, nothing is looked up. */
export function scanned(
	state: McpFeatureState,
	scope: "global" | "workspace",
	servers: ReadonlyArray<{ name: string; definition: PastedDefinition }>,
): Array<{ name: string; result: McpReviewRating }> | undefined {
	const rate = hostReview()?.rate;
	if (!rate) return undefined;
	const locations = state.configLocations();
	const source = scope === "global" ? locations.globalWrite : locations.projectWrite;
	return servers.flatMap(({ name, definition }) => {
		const config = validateMcpServerConfig(
			name,
			definition.transport === "stdio"
				? { command: definition.command, args: definition.args, env: definition.env }
				: { url: definition.url, headers: definition.headers },
		);
		return typeof config === "string"
			? []
			: [
					{
						name,
						result: rate({ name, config, source, scope: scope === "global" ? "global" : "project" }, state.sessionCwd),
					},
				];
	});
}

/** Shows each server's rating and its worst findings before anything is saved; `editLabel` names what going back edits. */
export async function confirmScan(
	ui: McpUi,
	rows: Array<{ name: string; result: McpReviewRating }>,
	editLabel = "Edit pasted JSON",
	editDescription = "Your text is kept",
): Promise<"save" | "edit" | "done"> {
	const action = await ui.menu(() => ({
		title: "Add MCP — security scan",
		facts: rows.map(({ name, result }) => ({
			label: name,
			value: `${result.rating} — ${result.findings[0] ?? "no rule matched"}`,
		})),
		details: [
			...rows.flatMap(({ name, result }) => result.findings.slice(1, 4).map((finding) => `${name}: ${finding}`)),
			"Static scan of the definition; nothing was started and its origin was not looked up. A rating is not a verdict.",
			"It is saved off and stays off until you approve it in /security.",
		].join("\n"),
		items: [
			{ value: "save", label: "Save (off)" },
			{ value: "edit", label: editLabel, description: editDescription },
		],
		confirmLabel: "choose",
		cancelLabel: "cancel",
	}));
	return action === "save" || action === "edit" ? action : "done";
}
