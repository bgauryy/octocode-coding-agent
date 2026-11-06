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
 * In `declared` mode (the default) no file is rendered: a tool is declared with the server's own description and full
 * input schema, and the block holds the server's instructions (plus an index line per deferred tool). Preset
 * overrides do not apply there; the server's text reaches the model verbatim.
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
} from "../compact/index.ts";
import { deferredLine, type McpDeferral } from "../deferral.ts";
import { firstSentence } from "./declaration.ts";
import { authoredTrigger, instructionsHead, residentBlock } from "./deferred.ts";
import { changedContract, sameCatalog, sameContract, shownDescription } from "./contract.ts";
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
	/** The described tools the block lists by name and trigger only (`deferral.ts`). */
	deferred: ReadonlySet<string>;
}

interface Described extends DescribedServer {
	generated: GeneratedServer | undefined;
	/** Bytes of the block's direct part, which an `auto:<bytes>` budget counts. */
	directBytes: number;
}

const NO_DEFERRAL: McpDeferral = { deferred: new Set() };

export class McpPresentation {
	readonly #options: McpPresentationOptions;
	readonly #latest = new Map<string, GeneratedServer>();
	readonly #frozen = new Map<string, Described>();

	constructor(options: McpPresentationOptions) {
		this.#options = options;
	}

	/** Whether servers are rendered as generated TypeScript files: `compact` only. */
	get enabled(): boolean {
		return this.#options.mode() === "compact";
	}

	/** Whether tools carry their description and schema in their own declarations (`declared`), not in the block. */
	get declared(): boolean {
		return this.#options.mode() === "declared";
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
	describe(
		name: string,
		tools: readonly string[],
		instructions: string | undefined,
		ready: boolean,
		deferral: McpDeferral = NO_DEFERRAL,
	): DescribedServer {
		const known = this.#frozen.get(name);
		const generated = this.#latest.get(name);
		const renewed =
			ready && known?.generated !== undefined && generated !== undefined
				? changedContract(known.generated, generated, known.tools)
				: false;
		if (known && !(known.pending && ready) && !renewed) return known;
		const offered = generated ? tools.filter((tool) => generated.tools.has(tool)) : [];
		const resident = generated ? this.#resident(name, generated, offered, instructions, deferral) : undefined;
		const described: Described = {
			generated,
			file: resident?.file,
			contract: resident?.text || instructions?.trim() || undefined,
			instructions,
			tools: new Set(tools),
			pending: !ready,
			deferred: resident?.deferred ?? new Set(),
			directBytes: resident?.directBytes ?? 0,
		};
		this.#frozen.set(name, described);
		return described;
	}

	/** The block of the offered tools with the deferral applied (`residentBlock`). */
	#resident(
		name: string,
		generated: GeneratedServer,
		offered: readonly string[],
		instructions: string | undefined,
		deferral: McpDeferral,
	) {
		// Only servers that sort before this one count, the order the prompt lists them in (`events.ts`), so a server that
		// connects late is measured as if it had connected in time. A later-named block already shown stays as it is: the
		// prefix never flips for a server that connects after it.
		let spent = 0;
		for (const [server, described] of this.#frozen) if (server < name) spent += described.directBytes;
		const prefix = `mcp__${generated.callName}__`;
		const declared = this.declared;
		return residentBlock({
			offered,
			deferral,
			spent,
			contractOf: (tools) =>
				declared
					? this.#declaredContract(generated, tools, instructions)
					: this.#contract(generated, tools, instructions),
			instructionsOf: () => (declared ? (instructions?.trim() ?? "") : instructionsHead(generated, instructions)),
			indexLine: (tool) => {
				const call = generated.toolNames[tool]?.startsWith(prefix)
					? generated.toolNames[tool].slice(prefix.length)
					: tool;
				const shown = shownDescription(generated.tools.get(tool) as McpTool);
				return deferredLine(
					call,
					authoredTrigger(generated.overrides, tool) ?? (shown ? firstSentence(shown) : undefined),
				);
			},
		});
	}

	/**
	 * `declared` mode: the block holds the server's instructions only; the tools' descriptions and schemas are in their
	 * declarations. The bytes are what the instructions and those declarations cost, for an `auto:<bytes>` budget.
	 */
	#declaredContract(
		generated: GeneratedServer,
		tools: readonly string[],
		instructions: string | undefined,
	): { file: undefined; text: string; bytes: number } {
		const text = instructions?.trim() ?? "";
		const declarations = tools.map((tool) => {
			const offered = generated.tools.get(tool) as McpTool;
			return Buffer.byteLength(`${shownDescription(offered) ?? ""}${JSON.stringify(offered.inputSchema)}`);
		});
		return { file: undefined, text, bytes: declarations.reduce((sum, size) => sum + size, Buffer.byteLength(text)) };
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
		if (!described || !described.tools.has(tool.name)) return false;
		// `declared`: only a deferred tool is thin; every other tool carries its full declaration.
		if (this.declared ? !described.deferred.has(tool.name) : !described.contract) return false;
		const before = described.generated?.tools.get(tool.name);
		return before !== undefined && sameContract(before, tool);
	}

	/**
	 * The description of a thin declaration of the tool, from the frozen file: the tool's authored trigger, else the
	 * first sentence of its rewritten description. Undefined without either; the declaration then uses the first
	 * sentence of the server's description.
	 */
	summary(name: string, tool: string): string | undefined {
		return authoredTrigger(this.#frozen.get(name)?.generated?.overrides, tool);
	}

	/** Whether the prompt's block lists the tool by name and trigger only. */
	isDeferred(name: string, tool: string): boolean {
		return this.#frozen.get(name)?.deferred.has(tool) === true;
	}

	/** The latest TypeScript block of one tool, for validation failures. */
	signature(name: string, tool: string): string | undefined {
		return this.#latest.get(name)?.blocks.get(tool);
	}
}
