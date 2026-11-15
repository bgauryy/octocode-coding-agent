import { McpAddError, mcpNameCollisions, saveMcpDefinition } from "./add.ts";
import { hostReview, type McpReviewRating } from "./host.ts";
import { validateMcpServerConfig } from "./servers.ts";
import { addMcpByFields, addOptions, chooseAddScope } from "./add-form.ts";
import {
	literalValuePaths,
	mcpServerNameError,
	parseMcpPaste,
	pastedAddCommand,
	type PastedServer,
} from "./add-parse.ts";
import type { McpExtensionState } from "./state.ts";
import type { McpUi } from "./ui.ts";

export interface AddMcpUiOptions {
	/** Where the MCP documentation page lives on this machine; shown in the paste prompt. */
	docsPath?: string;
}

const PASTE_TITLE = "Add MCP — paste a valid JSON MCP definition";
const EXAMPLES = [
	'stdio: {"mcpServers":{"docs":{"command":"npx","args":["-y","some-mcp-server"],"env":{"TOKEN":"${TOKEN}"}}}}',
	'http:  {"mcpServers":{"api":{"url":"https://example.com/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}}}',
];

function pasteHint(docsPath: string | undefined): string {
	return [
		'Paste {"mcpServers":{name:{...}}}, {name:{...}}, or one server ({"command":...} or {"url":...}).',
		...EXAMPLES,
		...(docsPath ? [`Docs: ${docsPath}`] : []),
		"Submit an empty line to build it field by field.",
	].join("\n");
}

type Next = "edit" | "field" | undefined;

/** Show a problem and offer to fix the pasted text (kept) or switch to the field form; undefined cancels. */
async function problem(ui: McpUi, title: string, lines: string[], details?: string): Promise<Next> {
	const next = await ui.menu(() => ({
		title,
		error: lines.join("\n"),
		details,
		items: [
			{ value: "edit", label: "Edit pasted JSON", description: "Your text is kept" },
			{ value: "field", label: "Build it field by field" },
		],
		confirmLabel: "choose",
		cancelLabel: "cancel",
	}));
	return next === "edit" || next === "field" ? next : undefined;
}

/** Ask the name of a bare server object until it is valid; undefined cancels. */
async function askName(state: McpExtensionState, ui: McpUi): Promise<string | undefined> {
	let hint = "Letters, digits, underscores or hyphens; no ambiguous double separators.";
	let draft = "";
	for (;;) {
		const value = await ui.input?.("Add MCP — name this server", draft, hint);
		if (value === undefined || state.session.signal.aborted) return undefined;
		draft = value.trim();
		const error = mcpServerNameError(draft);
		if (!error) return draft;
		hint = `${error}. Try again.`;
	}
}

/** The host's static scan of each pasted server, or undefined when the host installed none: nothing runs, nothing is looked up. */
function scanned(
	state: McpExtensionState,
	scope: "global" | "workspace",
	servers: ReadonlyArray<{ name: string; definition: PastedServer["definition"] }>,
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

/** Shows each server's rating and its worst findings before anything is saved; true to save. */
async function confirmScan(
	ui: McpUi,
	rows: Array<{ name: string; result: McpReviewRating }>,
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
			{ value: "edit", label: "Edit pasted JSON", description: "Your text is kept" },
		],
		confirmLabel: "choose",
		cancelLabel: "cancel",
	}));
	return action === "save" || action === "edit" ? action : "done";
}

/** After a valid paste: name, literal-value warning, scope, collision preflight, scan, save every server, report each. */
async function reviewAndSave(state: McpExtensionState, ui: McpUi, pasted: PastedServer[]): Promise<"edit" | "done"> {
	const servers: Array<{ name: string; definition: PastedServer["definition"] }> = [];
	for (const { name, definition } of pasted) {
		const chosen = name ?? (await askName(state, ui));
		if (chosen === undefined) return "done";
		servers.push({ name: chosen, definition });
	}
	const literals = literalValuePaths(servers);
	if (literals.length > 0) {
		const action = await ui.menu(() => ({
			title: "Add MCP — literal values",
			error: `These values are saved to disk as typed, not as \${VAR} references:\n${literals.join("\n")}`,
			details: "Prefer a reference such as ${TOKEN} so the secret stays out of the file.",
			items: [
				{ value: "save", label: "Continue" },
				{ value: "edit", label: "Edit pasted JSON", description: "Your text is kept" },
			],
			confirmLabel: "choose",
			cancelLabel: "cancel",
		}));
		if (action === "edit") return "edit";
		if (action !== "save") return "done";
	}
	const scope = await chooseAddScope(state, ui);
	if (!scope || state.session.signal.aborted) return "done";
	const options = addOptions(state);
	const taken = mcpNameCollisions(
		servers.map((server) => server.name),
		options,
	);
	if (taken.length > 0) {
		const next = await problem(
			ui,
			"MCP not saved",
			taken.map((name) => `${name}: an MCP server with this name already exists`),
		);
		return next === "edit" ? "edit" : "done";
	}
	const rated = scanned(state, scope, servers);
	if (rated) {
		const choice = await confirmScan(ui, rated);
		if (choice !== "save") return choice;
	}
	const rows = servers.map(({ name, definition }) => {
		try {
			saveMcpDefinition(pastedAddCommand(name, scope, definition), options);
			return { label: name, value: "saved (off, unassigned)" };
		} catch (cause) {
			return { label: name, value: cause instanceof McpAddError ? cause.message : "not saved" };
		}
	});
	await ui.menu(() => ({
		title: rows.every((row) => row.value.startsWith("saved")) ? "MCP saved" : "MCP save finished with errors",
		facts: rows,
		details:
			"Saved off and unassigned. Run /reload, review in /security, then enable and assign it. Nothing was started.",
		items: [{ value: "done", label: "Done" }],
		confirmLabel: "close",
		cancelLabel: "close",
	}));
	return "done";
}

/** Paste a JSON definition (or fall back to the field form), choose where to save, save disabled and unassigned. */
export async function addMcpWithUi(state: McpExtensionState, ui: McpUi, options: AddMcpUiOptions = {}): Promise<void> {
	if (!ui.input) return;
	let draft = "";
	for (;;) {
		const text = await ui.input(PASTE_TITLE, draft, pasteHint(options.docsPath));
		if (text === undefined || state.session.signal.aborted) return;
		draft = text;
		if (!text.trim()) {
			const choice = await ui.menu(() => ({
				title: "Add MCP",
				items: [
					{ value: "paste", label: "Paste JSON" },
					{ value: "field", label: "Build it field by field" },
				],
				confirmLabel: "choose",
				cancelLabel: "cancel",
			}));
			if (choice === "field") return addMcpByFields(state, ui);
			if (choice === "paste") continue;
			return;
		}
		const parsed = parseMcpPaste(text);
		const next =
			"errors" in parsed
				? await problem(ui, "Add MCP — invalid definition", parsed.errors, "Values are never shown in errors.")
				: await reviewAndSave(state, ui, parsed.servers);
		if (next === "field") return addMcpByFields(state, ui);
		if (next !== "edit") return;
	}
}
