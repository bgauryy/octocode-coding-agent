/**
 * What the model reads of an MCP server: its own instructions and, for each tool declared to the agent, the tool's
 * description and schema, in one block of the system prompt (`describe`). Every server takes the same path. The
 * notation is a generated TypeScript file per server (see `../compact`), rendered when the server's catalog changes and
 * stored under `<agentDir>/context-optimization/mcp/` (a workspace-defined server: the project's folder,
 * `serverGeneratedDir`); a preset's overrides refine its wording, nothing more. A tool whose block fails the fidelity
 * check (`checkToolBlock`: a part the renderer cannot express), and every tool when the mode is `json`, is described
 * in plain form instead: the server's description and JSON Schema as sent (`jsonToolBlock`). Providers get thin tool
 * declarations in both forms; calls are still validated against the server's own JSON Schema.
 *
 * Two copies of a server's file exist per session. The `latest` one follows the server (validation hints read it). The
 * `described` one is what the system prompt's block says of the server (`describe`): taken when the prompt first
 * describes the server's catalog, kept while the server reconnects, fails or drops, and renewed when the loadout is
 * rebuilt (`rebuild`), the server goes away (`forget`), or the server's contract changes (`changedContract`): its
 * instructions, or a described tool's description or schemas. Thin declarations follow it, so a reconnect or a
 * withdrawn tool changes neither the block nor the declarations built from it, and a changed contract reaches the
 * model as one patch of the section with the changed tool thin again in the same request. What the model already
 * has is the transcript's business: the prompt sections are diffed against the replayed ones, so the patch is sent
 * once and holds across compaction, resume and fork.
 */

import { isDeepStrictEqual } from "node:util";
import type { Tool as McpTool } from "../client/index.ts";
import {
	checkToolBlock,
	type CompactServerInput,
	type DescriptionOverrides,
	functionNames,
	generatedDir,
	resolveServerFile,
	selectTools,
	toolBlock,
	unoptimizedTools,
} from "../compact/index.ts";
import { firstSentence } from "./declaration.ts";
import { jsonContract, jsonToolBlock } from "./json-block.ts";

import { DEFAULT_MCP_PRESENTATION, type McpPresentationMode } from "./mode.ts";

export { DEFAULT_MCP_PRESENTATION, type McpPresentationMode };

export interface McpPresentationOptions {
	agentDir: () => string;
	/** The folder of a server's generated file, by configured name (`serverGeneratedDir`); defaults to the user folder. */
	dir?: (name: string) => string;
	mode: () => McpPresentationMode;
	/** Overrides shipped with the server's preset that describe this catalog (see `McpServerPreset.compactOverrides`). */
	presetOverrides?: (name: string, input: CompactServerInput) => DescriptionOverrides | undefined;
}

interface GeneratedServer {
	callName: string;
	text: string;
	overrides: DescriptionOverrides | undefined;
	instructions: string | undefined;
	tools: ReadonlyMap<string, McpTool>;
	/** Each tool's block of `text`, by the server's tool name; a tool the text lacks or does not render faithfully has none. */
	blocks: ReadonlyMap<string, string>;
	/** Each tool's function name in `text`, by the server's tool name. */
	functions: ReadonlyMap<string, string>;
	/** The name the model calls each tool by, by the server's tool name. */
	calls: ReadonlyMap<string, string>;
	/** The names the model calls the tools by, which the text was rendered with. */
	toolNames: Readonly<Record<string, string>>;
}

/** What the prompt's block describes of one server. */
export interface DescribedServer {
	/** The generated file restricted to the tools it renders faithfully; undefined without one (`json`, or no faithful block). */
	file: string | undefined;
	/**
	 * What the block holds: the server's instructions and each described tool's description and schema (the file, plus
	 * the plain form of tools it does not carry). Undefined when no tool is described and no instructions exist.
	 */
	contract: string | undefined;
	/** The server's instructions when the block was described. */
	instructions: string | undefined;
	/** The server's tool names the block describes: the ones declared when it was described. */
	tools: ReadonlySet<string>;
	/** Described before the server's catalog was known, so the block holds no contract yet. */
	pending: boolean;
}

interface Described extends DescribedServer {
	generated: GeneratedServer | undefined;
}

const sameCatalog = (
	generated: GeneratedServer,
	instructions: string | undefined,
	tools: readonly McpTool[],
	toolNames: Readonly<Record<string, string>>,
) =>
	generated.instructions === instructions &&
	isDeepStrictEqual(generated.toolNames, toolNames) &&
	generated.tools.size === tools.length &&
	tools.every((tool) => generated.tools.get(tool.name) === tool);

/** The text the block shows as a tool's description: its own, else its title (`jsonToolBlock`). */
const shownDescription = (tool: McpTool) => (tool.description?.trim() ? tool.description : tool.title?.trim());

/**
 * What the block says of a tool: its description and schemas. Other fields the catalog keeps (`title` beside a
 * description, `execution`) are not part of it, so they neither renew the block nor undo a thin declaration.
 */
const sameContract = (left: McpTool, right: McpTool) =>
	left === right ||
	(shownDescription(left) === shownDescription(right) &&
		isDeepStrictEqual(left.inputSchema, right.inputSchema) &&
		isDeepStrictEqual(left.outputSchema, right.outputSchema));

/**
 * Whether the latest catalog changes what the block says: the server's instructions, or the description or schemas
 * of a tool it describes that the server still offers. A tool the server no longer offers or one it newly offers is
 * not a change of the block (the status names the first, the second is declared in full), nor is a reconnect, whose
 * catalog keeps the same tools (`McpCatalogCache`).
 */
const changedContract = (described: GeneratedServer, latest: GeneratedServer, tools: ReadonlySet<string>) =>
	described !== latest &&
	((described.instructions ?? "") !== (latest.instructions ?? "") ||
		[...tools].some((name) => {
			const before = described.tools.get(name);
			const now = latest.tools.get(name);
			return before !== undefined && now !== undefined && !sameContract(before, now);
		}));

export class McpPresentation {
	readonly #options: McpPresentationOptions;
	readonly #latest = new Map<string, GeneratedServer>();
	readonly #frozen = new Map<string, Described>();
	/** Tools without rewritten descriptions, by server, for servers whose file was rendered in this session. */
	readonly #unoptimized = new Map<string, string[]>();

	constructor(options: McpPresentationOptions) {
		this.#options = options;
	}

	/** Whether servers are rendered as generated TypeScript files; false (`json`) describes every tool in plain form. */
	get enabled(): boolean {
		return this.#options.mode() !== "json";
	}

	/**
	 * Bring the server's catalog up to date: in `compact` mode its file (`resolveServerFile`): the stored file while it
	 * matches, else a new render that keeps the overrides of unchanged tools. `name` is the configured server name,
	 * `callName` what tool names carry after `mcp__`, `names` the registered tool name of each tool. Never throws:
	 * without a catalog the server keeps its full JSON declarations.
	 */
	sync(
		name: string,
		callName: string,
		instructions: string | undefined,
		tools: readonly McpTool[],
		names: ReadonlyMap<string, string> = new Map(),
	): void {
		// A dropped connection withdraws its catalog; what the prompt describes stays until `forget` or `rebuild`.
		if (tools.length === 0) {
			this.#latest.delete(name);
			return;
		}
		const toolNames = Object.fromEntries(
			tools.flatMap((tool) => {
				const registered = names.get(tool.name);
				return registered === undefined ? [] : [[tool.name, registered] as const];
			}),
		);
		const known = this.#latest.get(name);
		if (known && sameCatalog(known, instructions, tools, toolNames)) return;
		try {
			const input: CompactServerInput = {
				server: callName,
				...(instructions ? { instructions } : {}),
				tools: tools.map(({ name, description, inputSchema, outputSchema }) => ({
					name,
					...(description ? { description } : {}),
					inputSchema,
					...(outputSchema ? { outputSchema } : {}),
				})),
				...(Object.keys(toolNames).length ? { toolNames } : {}),
			};
			const names = functionNames(input);
			const functions = new Map([...names].map(([tool, { fn }]) => [tool, fn]));
			const calls = new Map([...names].map(([tool, { call }]) => [tool, call]));
			let text = "";
			let overrides: DescriptionOverrides | undefined;
			const blocks = new Map<string, string>();
			if (this.enabled) {
				// The stored files are a cache for the next session and for tooling; this session reads the text from memory,
				// so a failed write changes nothing here.
				const dir = this.#options.dir?.(name) ?? generatedDir(this.#options.agentDir());
				const file = resolveServerFile(dir, name, input, {
					preset: this.#options.presetOverrides?.(name, input),
				});
				text = file.text;
				overrides = file.meta.overrides;
				if (file.rendered) {
					const plain = unoptimizedTools(input, overrides);
					if (plain.length) this.#unoptimized.set(name, plain);
					else this.#unoptimized.delete(name);
				}
				// The plain render is checked too: a tool it cannot express is described in plain form (see `describe`).
				for (const tool of input.tools) {
					const block = toolBlock(text, functions.get(tool.name) ?? tool.name);
					if (block && checkToolBlock(tool, block).length === 0) blocks.set(tool.name, block);
				}
			}
			const generated: GeneratedServer = {
				callName,
				text,
				overrides,
				instructions,
				tools: new Map(tools.map((tool) => [tool.name, tool])),
				blocks,
				functions,
				calls,
				toolNames,
			};
			this.#latest.set(name, generated);
		} catch {
			this.#latest.delete(name);
		}
	}

	/**
	 * Drop a server's latest file, for a server whose tools are hidden (stopped or disabled). What the prompt describes
	 * stays while the prompt lists the server (`retainDescribed`), so a stop changes only the status section.
	 */
	forget(name: string): void {
		this.#latest.delete(name);
	}

	/** Drop the descriptions of servers the prompt no longer lists (disabled, removed, unselected). */
	retainDescribed(names: ReadonlySet<string>): void {
		for (const name of this.#frozen.keys()) if (!names.has(name)) this.#frozen.delete(name);
	}

	/** Forget every file, for a session that starts. */
	reset(): void {
		this.#latest.clear();
		this.#frozen.clear();
		this.#unoptimized.clear();
	}

	/** Renew every description from the latest files: the loadout is being rebuilt, so the prompt is rebuilt anyway. */
	rebuild(): void {
		const previous = [...this.#latest];
		this.#latest.clear();
		this.#frozen.clear();
		for (const [name, generated] of previous)
			this.sync(
				name,
				generated.callName,
				generated.instructions,
				[...generated.tools.values()],
				new Map(Object.entries(generated.toolNames)),
			);
	}

	/**
	 * What the prompt describes of the server, fixed by the first call: `tools` are the server's tool names declared now,
	 * `ready` whether its catalog is known (the server is connected). A description taken before the catalog was known
	 * is replaced once by the first ready one, so a server that connects late gets its contract once; after that the
	 * description stays while the server reconnects, fails or drops, until `rebuild` or `forget`, and is taken again
	 * when the connected server's contract changes (`changedContract`).
	 */
	describe(name: string, tools: readonly string[], instructions: string | undefined, ready: boolean): DescribedServer {
		const known = this.#frozen.get(name);
		const generated = this.#latest.get(name);
		const renewed =
			ready && known?.generated !== undefined && generated !== undefined
				? changedContract(known.generated, generated, known.tools)
				: false;
		if (known && !(known.pending && ready) && !renewed) return known;
		const offered = generated ? tools.filter((tool) => generated.tools.has(tool)) : [];
		const resident = generated ? this.#contract(generated, offered, instructions) : undefined;
		const described: Described = {
			generated,
			file: resident?.file,
			contract: resident?.text || instructions?.trim() || undefined,
			instructions,
			tools: new Set(tools),
			pending: !ready,
		};
		this.#frozen.set(name, described);
		return described;
	}

	/**
	 * The block text of the given tools: the file of those it renders faithfully (its header carries the instructions),
	 * then the others in plain form. Empty text without either.
	 */
	#contract(
		generated: GeneratedServer,
		tools: readonly string[],
		instructions: string | undefined,
	): { file: string | undefined; text: string } {
		const faithful = tools.filter((tool) => generated.blocks.has(tool));
		const plain = tools.filter((tool) => !generated.blocks.has(tool));
		const file =
			faithful.length > 0
				? selectTools(
						generated.text,
						faithful.map((tool) => generated.functions.get(tool) ?? tool),
					).trimEnd()
				: undefined;
		const plainBlocks = plain.map((tool) =>
			jsonToolBlock(generated.calls.get(tool) ?? tool, generated.tools.get(tool) as McpTool),
		);
		const text = file
			? [file, ...plainBlocks].join("\n")
			: plainBlocks.length > 0
				? jsonContract(generated.callName, instructions, plainBlocks)
				: "";
		return { file, text };
	}

	/** Whether the tool is declared as a thin stub: the prompt's block describes this tool's contract, in either form. */
	isThin(name: string, tool: McpTool): boolean {
		const described = this.#frozen.get(name);
		if (!described?.contract || !described.tools.has(tool.name)) return false;
		const before = described.generated?.tools.get(tool.name);
		return before !== undefined && sameContract(before, tool);
	}

	/**
	 * The description of a thin declaration of the tool, from the frozen file: the tool's authored trigger, else the
	 * first sentence of its rewritten description. Undefined without either; the declaration then uses the first
	 * sentence of the server's description.
	 */
	summary(name: string, tool: string): string | undefined {
		const overrides = this.#frozen.get(name)?.generated?.overrides;
		const trigger = overrides?.triggers?.[tool]?.trim();
		if (trigger) return trigger;
		const description = overrides?.tools?.[tool];
		return description ? firstSentence(description) : undefined;
	}

	/**
	 * Servers whose file was rendered in this session (a new or changed catalog) with tools no override rewrites, each
	 * reported once: the `octocode-context-optimization` skill writes their descriptions.
	 */
	takeUnoptimized(): Array<{ server: string; tools: string[] }> {
		const pending = [...this.#unoptimized].map(([server, tools]) => ({ server, tools }));
		this.#unoptimized.clear();
		return pending;
	}

	/** The latest TypeScript block of one tool, for validation failures. */
	signature(name: string, tool: string): string | undefined {
		return this.#latest.get(name)?.blocks.get(tool);
	}
}
