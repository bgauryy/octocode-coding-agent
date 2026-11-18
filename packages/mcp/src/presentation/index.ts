/**
 * What the model reads of an MCP server: its own instructions and, for each tool declared to the agent, the tool's
 * description and schema, in one block of the system prompt (`describe`). Every server takes the same path. The
 * notation is a generated TypeScript file per server (see `../compact`), rendered when the server's catalog changes and
 * stored under `<agentDir>/context-optimization/mcp/` (a workspace-defined server: the project's folder,
 * `serverGeneratedDir`). The server's description, schema and instructions are never rewritten: the model reads the
 * server's own text. A tool whose block fails the fidelity
 * check (`checkToolBlock`: a part the renderer cannot express), and every tool when the mode is `json`, is described
 * in plain form instead: the server's description and JSON Schema as sent (`jsonToolBlock`). Providers get thin tool
 * declarations in both forms; calls are still validated against the server's own JSON Schema.
 *
 * In `declared` mode (the default) no file is rendered: a tool is declared with the server's own description and full
 * input schema, and the block holds the server's instructions (plus an index line per deferred tool).
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
 *
 * A deferred tool in `declared` mode can be declared in full later in the session (`load`, see `../redeclare.ts`). The
 * block keeps its line for the tool, so only the tool's declaration changes.
 */

import type { Tool as McpTool } from "../client/index.ts";
import {
	checkToolBlock,
	type CompactServerInput,
	functionNames,
	generatedDir,
	resolveServerFile,
	toolBlock,
} from "../compact/index.ts";
import { deferredLine, type McpDeferral } from "../deferral.ts";
import { firstSentence } from "./declaration.ts";
import { instructionsHead, onDemandTrigger, residentBlock } from "./deferred.ts";
import { changedContract, sameCatalog, sameContract, shownDescription } from "./contract.ts";
import { contractText, declaredContract } from "./contract-text.ts";
import type { Described, DescribedServer, GeneratedServer } from "./types.ts";

import { DEFAULT_MCP_PRESENTATION, type McpPresentationMode } from "./mode.ts";

export { DEFAULT_MCP_PRESENTATION, type McpPresentationMode };
export type { DescribedServer };

export interface McpPresentationOptions {
	agentDir: () => string;
	/** The folder of a server's generated file, by configured name (`serverGeneratedDir`); defaults to the user folder. */
	dir?: (name: string) => string;
	mode: () => McpPresentationMode;
}

const NO_DEFERRAL: McpDeferral = { deferred: new Set() };

export class McpPresentation {
	readonly #options: McpPresentationOptions;
	readonly #latest = new Map<string, GeneratedServer>();
	readonly #frozen = new Map<string, Described>();
	/** Deferred tools declared in full for the rest of the session (`load`), as `<server>\0<tool>`. */
	readonly #loaded = new Set<string>();

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
	 * matches, else a new render. `name` is the configured server name,
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
			const blocks = new Map<string, string>();
			if (this.enabled) {
				// The stored files are a cache for the next session and for tooling; this session reads the text from memory,
				// so a failed write changes nothing here.
				const dir = this.#options.dir?.(name) ?? generatedDir(this.#options.agentDir());
				const file = resolveServerFile(dir, name, input);
				text = file.text;
				// The plain render is checked too: a tool it cannot express is described in plain form (see `describe`).
				for (const tool of input.tools) {
					const block = toolBlock(text, functions.get(tool.name) ?? tool.name);
					if (block && checkToolBlock(tool, block).length === 0) blocks.set(tool.name, block);
				}
			}
			const generated: GeneratedServer = {
				callName,
				text,
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
		this.#loaded.clear();
	}

	/**
	 * Declare a described, deferred tool in full from now on (`declared` mode only: elsewhere the block carries the
	 * contract). True when this changes its declaration; the block is not changed.
	 */
	load(name: string, tool: string): boolean {
		const key = `${name}\0${tool}`;
		if (!this.declared || this.#loaded.has(key) || !this.#frozen.get(name)?.deferred.has(tool)) return false;
		this.#loaded.add(key);
		return true;
	}

	/** Forget which tools were loaded: the session moved to another branch, whose transcript says what it declares. */
	forgetLoaded(): void {
		this.#loaded.clear();
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
			onDemand: resident?.onDemand ?? new Set(),
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
		const callOf = (tool: string) =>
			generated.toolNames[tool]?.startsWith(prefix) ? generated.toolNames[tool].slice(prefix.length) : tool;
		const declared = this.declared;
		// Undeclared tools are listed in catalog order, after the deferred ones.
		const onDemand = new Set([...generated.tools.keys()].filter((tool) => deferral.onDemand?.has(tool)));
		return residentBlock({
			offered,
			deferral: { ...deferral, onDemand },
			spent,
			contractOf: (tools) =>
				declared ? declaredContract(generated, tools, instructions) : contractText(generated, tools, instructions),
			instructionsOf: () => (declared ? (instructions?.trim() ?? "") : instructionsHead(generated, instructions)),
			onDemandLine: (tool) =>
				deferredLine(callOf(tool), onDemandTrigger(shownDescription(generated.tools.get(tool) as McpTool))),
			indexLine: (tool) => {
				const call = callOf(tool);
				// `declared`: the tool's declaration already carries its whole description.
				if (declared) return deferredLine(call, undefined);
				const shown = shownDescription(generated.tools.get(tool) as McpTool);
				return deferredLine(call, shown ? firstSentence(shown) : undefined);
			},
		});
	}

	/** Whether the tool is declared as a thin stub: the prompt's block describes this tool's contract, in either form. */
	isThin(name: string, tool: McpTool): boolean {
		const described = this.#frozen.get(name);
		if (!described || !described.tools.has(tool.name)) return false;
		// `declared`: only a deferred tool not loaded since is thin; every other tool carries its full declaration.
		const full = !described.deferred.has(tool.name) || this.#loaded.has(`${name}\0${tool.name}`);
		if (this.declared ? full : !described.contract) return false;
		const before = described.generated?.tools.get(tool.name);
		return before !== undefined && sameContract(before, tool);
	}

	/** Whether the prompt's block lists the tool by name and trigger without declaring it (`on-demand.ts`). */
	isListedOnDemand(name: string, tool: string): boolean {
		return this.#frozen.get(name)?.onDemand.has(tool) === true;
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
