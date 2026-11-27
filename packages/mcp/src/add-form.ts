import type { McpAddCommand } from "@octocodeai/octocode-contracts/config";
import { hostPaths } from "./host.ts";
import { McpAddError, saveMcpDefinition, type McpAddOptions } from "./add.ts";
import type { PastedDefinition } from "./add-parse.ts";
import { confirmScan, scanned } from "./add-scan.ts";
import type { McpFeatureState } from "./state.ts";
import type { McpUi } from "./ui.ts";

export type AddScope = "global" | "workspace";

/** Where saves land and which names are taken, for the session now. */
export function addOptions(state: McpFeatureState): McpAddOptions {
	return {
		agentDir: hostPaths().agentDir(),
		cwd: state.sessionCwd,
		projectTrusted: state.projectTrusted,
		existingNames: [
			...new Set([
				...state.servers.map((server) => server.entry.name),
				...state.api.mcpServers.list().map((server) => server.name),
			]),
		],
	};
}

/** The workspace choice appears only when the workspace is trusted. */
export async function chooseAddScope(state: McpFeatureState, ui: McpUi): Promise<AddScope | undefined> {
	const choice = await ui.menu(() => ({
		title: "Add MCP — save to",
		items: [
			{ value: "global", label: "Global", description: state.configLocations().globalWrite },
			...(state.projectTrusted
				? [{ value: "workspace", label: "This workspace", description: state.configLocations().projectWrite }]
				: []),
		],
		details: "Saved off; review in /security before enabling. Nothing starts on save.",
		confirmLabel: "choose",
		cancelLabel: "cancel",
	}));
	return choice === "global" || choice === "workspace" ? choice : undefined;
}

/** What the scan reads from a typed command: the same shape a pasted definition has. */
function scannedDefinition(command: McpAddCommand): PastedDefinition {
	return command.transport === "stdio"
		? { transport: "stdio", command: command.command, args: command.args ?? [], env: command.env }
		: { transport: "http", url: command.url, headers: command.headers };
}

/** The field-by-field form: scope, transport, then fields. A draft stays in the view until save or cancellation. */
export async function addMcpByFields(state: McpFeatureState, ui: McpUi): Promise<void> {
	if (!ui.input) return;
	const scope = await chooseAddScope(state, ui);
	if (!scope) return;
	const transport = await ui.menu(() => ({
		title: "Add MCP — transport",
		items: [
			{ value: "stdio", label: "Stdio", description: "Executable command and separate arguments" },
			{ value: "http", label: "HTTP", description: "Streamable HTTP endpoint" },
		],
		confirmLabel: "choose",
		cancelLabel: "cancel",
	}));
	if (transport !== "stdio" && transport !== "http") return;
	const fields =
		transport === "stdio"
			? [
					["name", "Server name", "Letters, digits, underscores or hyphens; no ambiguous double separators."],
					["target", "Command", "Executable name or path only, not a shell command line."],
					["args", "Arguments (JSON array)", 'Example: ["--port", "3000"]. Each string is one argument.'],
					[
						"extras",
						"Environment (JSON object)",
						'Optional: {"TOKEN":"${TOKEN}"}. Prefer environment references; values are saved to disk.',
					],
				]
			: [
					["name", "Server name", "Letters, digits, underscores or hyphens; no ambiguous double separators."],
					["target", "HTTP URL", "An http:// or https:// Streamable HTTP endpoint."],
					[
						"extras",
						"Headers (JSON object)",
						'Optional: {"Authorization":"Bearer ${TOKEN}"}. Values are saved to disk.',
					],
				];
	const draft: Record<string, string> = { name: "", target: "", args: "[]", extras: "{}" };
	let error: string | undefined;
	for (;;) {
		for (const [key, label, hint] of fields) {
			const value = await ui.input(`Add MCP — ${label}`, draft[key], hint);
			if (value === undefined || state.session.signal.aborted) return;
			draft[key] = value;
		}
		const action = await ui.menu(() => ({
			title: "Add MCP — save definition?",
			error,
			details: `${scope === "global" ? "Global" : "Workspace"} · ${transport}. Saved off and unassigned; no connection or approval.`,
			items: [
				{ value: "save", label: "Save MCP" },
				{ value: "edit", label: "Edit fields" },
			],
			confirmLabel: "choose",
			cancelLabel: "cancel",
		}));
		if (!action || state.session.signal.aborted) return;
		if (action === "edit") continue;
		try {
			const extras: unknown = JSON.parse(draft.extras || "{}");
			const command = {
				name: draft.name.trim(),
				scope,
				...(transport === "stdio"
					? { transport, command: draft.target, args: JSON.parse(draft.args || "[]") as unknown, env: extras }
					: { transport, url: draft.target.trim(), headers: extras }),
			} as McpAddCommand;
			const rated = scanned(state, scope, [{ name: command.name, definition: scannedDefinition(command) }]);
			if (rated) {
				// A definition the scan cannot rate is not one the save would accept: never save it unscanned.
				if (rated.length === 0)
					throw new McpAddError(
						"Invalid MCP name or transport configuration. Use an unambiguous name and an HTTP(S) URL or executable command.",
					);
				const choice = await confirmScan(ui, rated, "Edit fields", "Your input is preserved");
				if (choice === "edit") continue;
				if (choice !== "save") return;
			}
			const result = saveMcpDefinition(command, addOptions(state));
			await ui.menu(() => ({
				title: "MCP saved",
				details: result.message,
				items: [{ value: "done", label: "Done" }],
				confirmLabel: "close",
				cancelLabel: "close",
			}));
			return;
		} catch (cause) {
			error =
				cause instanceof McpAddError
					? cause.message
					: "Invalid JSON fields. Arguments must be a string array; environment or headers must map names to strings.";
			const retry = await ui.menu(() => ({
				title: "MCP not saved",
				error,
				items: [{ value: "edit", label: "Edit fields", description: "Your input is preserved" }],
				confirmLabel: "edit",
				cancelLabel: "cancel",
			}));
			if (!retry) return;
		}
	}
}
