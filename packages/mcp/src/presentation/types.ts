/** What the presentation keeps of each server: its latest catalog and what the prompt described of it. */

import type { DescriptionOverrides } from "../compact/index.ts";
import type { Tool as McpTool } from "../client/index.ts";

export interface GeneratedServer {
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
	/** The tools the block lists by name and trigger that are not declared at all (`on-demand.ts`). */
	onDemand: ReadonlySet<string>;
}

export interface Described extends DescribedServer {
	generated: GeneratedServer | undefined;
	/** Bytes of the block's direct part, which an `auto:<bytes>` budget counts. */
	directBytes: number;
}
