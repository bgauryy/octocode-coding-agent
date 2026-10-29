/**
 * What the model reads of an MCP server: a generated TypeScript file per server (see `../compact`). The file is
 * rendered when the server's catalog changes and stored under `<agentDir>/mcp-generated/`. Providers get thin tool
 * declarations; calls are still validated against the server's own JSON Schema.
 *
 * A tool whose block fails the fidelity check (`checkToolBlock`: a part the renderer cannot express) keeps its full
 * JSON declaration, so the generated file never stands in for a contract it does not carry.
 *
 * Two copies of a server's file exist per session. The `latest` one follows the server (validation hints read it). The
 * `frozen` one is taken when the server first appears and renewed only when the loadout is rebuilt (`rebuild`), so the
 * system prompt and the declarations built from it never change mid-run.
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

export type McpPresentationMode = "compact" | "json";
export const DEFAULT_MCP_PRESENTATION: McpPresentationMode = "compact";

export interface McpPresentationOptions {
	agentDir: () => string;
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
	/** The names the model calls the tools by, which the text was rendered with. */
	toolNames: Readonly<Record<string, string>>;
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

export class McpPresentation {
	readonly #options: McpPresentationOptions;
	readonly #latest = new Map<string, GeneratedServer>();
	readonly #frozen = new Map<string, GeneratedServer>();
	/** Tools without rewritten descriptions, by server, for servers whose file was rendered in this session. */
	readonly #unoptimized = new Map<string, string[]>();

	constructor(options: McpPresentationOptions) {
		this.#options = options;
	}

	/** Whether servers are presented through generated files; false (`json`) leaves every declaration as the server sent it. */
	get enabled(): boolean {
		return this.#options.mode() !== "json";
	}

	/**
	 * Bring the server's file up to date with its catalog (`resolveServerFile`): the stored file while it matches, else a
	 * new render that keeps the overrides of unchanged tools. `name` is the configured server name, `callName` what tool
	 * names carry after `mcp__`, `names` the registered tool name of each tool. Never throws: without a file the server
	 * keeps its JSON declarations.
	 */
	sync(
		name: string,
		callName: string,
		instructions: string | undefined,
		tools: readonly McpTool[],
		names: ReadonlyMap<string, string> = new Map(),
	): void {
		if (!this.enabled || tools.length === 0) {
			this.forget(name);
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
			// The stored files are a cache for the next session and for tooling; this session reads the text from memory, so
			// a failed write changes nothing here.
			const file = resolveServerFile(generatedDir(this.#options.agentDir()), name, input, {
				preset: this.#options.presetOverrides?.(name, input),
			});
			const { text } = file;
			const { overrides } = file.meta;
			if (file.rendered) {
				const plain = unoptimizedTools(input, overrides);
				if (plain.length) this.#unoptimized.set(name, plain);
				else this.#unoptimized.delete(name);
			}
			// The plain render is checked too: a tool it cannot express keeps its JSON declaration (see `isThin`).
			const functions = new Map([...functionNames(input)].map(([tool, { fn }]) => [tool, fn]));
			const blocks = new Map<string, string>();
			for (const tool of input.tools) {
				const block = toolBlock(text, functions.get(tool.name) ?? tool.name);
				if (block && checkToolBlock(tool, block).length === 0) blocks.set(tool.name, block);
			}
			const generated: GeneratedServer = {
				callName,
				text,
				overrides,
				instructions,
				tools: new Map(tools.map((tool) => [tool.name, tool])),
				blocks,
				functions,
				toolNames,
			};
			this.#latest.set(name, generated);
			if (!this.#frozen.has(name)) this.#frozen.set(name, generated);
		} catch {
			this.forget(name);
		}
	}

	/** Drop a server's files from this session, for a server that goes away. */
	forget(name: string): void {
		this.#latest.delete(name);
		this.#frozen.delete(name);
	}

	/** Forget every file, for a session that starts. */
	reset(): void {
		this.#latest.clear();
		this.#frozen.clear();
		this.#unoptimized.clear();
	}

	/** Renew the frozen files from the latest ones: the loadout is being rebuilt, so the prompt is rebuilt anyway. */
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

	/** Whether the tool is declared as a thin stub: the frozen file describes exactly this tool. */
	isThin(name: string, tool: McpTool): boolean {
		const frozen = this.#frozen.get(name);
		if (!this.enabled || !frozen?.blocks.has(tool.name)) return false;
		const described = frozen.tools.get(tool.name);
		return described === tool || isDeepStrictEqual(described, tool);
	}

	/**
	 * The description of a thin declaration of the tool, from the frozen file: the tool's authored trigger, else the
	 * first sentence of its rewritten description. Undefined without either; the declaration then uses the first
	 * sentence of the server's description.
	 */
	summary(name: string, tool: string): string | undefined {
		const overrides = this.#frozen.get(name)?.overrides;
		const trigger = overrides?.triggers?.[tool]?.trim();
		if (trigger) return trigger;
		const description = overrides?.tools?.[tool];
		return description ? firstSentence(description) : undefined;
	}

	/**
	 * Servers whose file was rendered in this session (a new or changed catalog) with tools no override rewrites, each
	 * reported once: the `octocode-compact-mcp` skill writes their descriptions.
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

	/** The frozen file restricted to the named tools, for the system prompt. */
	section(name: string, tools: readonly string[]): string | undefined {
		const frozen = this.#frozen.get(name);
		if (!frozen || tools.length === 0) return undefined;
		return selectTools(
			frozen.text,
			tools.map((tool) => frozen.functions.get(tool) ?? tool),
		).trimEnd();
	}
}
