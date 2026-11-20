/**
 * Schemas of deferred tools after a compaction. A deferred tool is declared with its top-level fields only, and its full
 * input schema reaches the model as a tool result (a refused call, or the `mcp` tool's `tools` intent). A compaction
 * summarizes those results away while the declaration stays thin, so the next call would be guessed again. After each
 * compaction the schemas of the deferred tools this session called come back as one hidden message, like the files
 * worked on (`compaction/restore.ts`): whole schemas only, most recently called first, within a budget. The server's
 * schema is sent as the server gave it. The declarations, and so the cached prefix, do not change.
 */

import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { deferredInputSchema } from "../../../../mcp/src/api.ts";
import type { FeatureSetup, SetupPick, FeatureContext } from "../../core/features/index.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { contextMessages } from "../files/reads.ts";
import { isStaleSessionError } from "../shared/util.ts";

export const RESTORED_SCHEMAS_TYPE = "octocode-restored-tool-schemas";

/** All restored schemas together stay within this many characters (about 9.6k tokens at `CHARS_PER_TOKEN`)... */
export const RESTORE_SCHEMAS_CHARS = 24_000;
/** ...and within this share of the model's context window. */
const RESTORE_SCHEMAS_SHARE = 0.03;

/** The tools `messages` call, most recently called first, each once. */
export function calledTools(messages: readonly unknown[]): string[] {
	const names: string[] = [];
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at];
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let index = message.content.length - 1; index >= 0; index--) {
			const block: unknown = message.content[index];
			if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string" && !names.includes(block.name))
				names.push(block.name);
		}
	}
	return names;
}

/** The tools whose schemas the restored-schema messages among `messages` (the context after a compaction) still show. */
function stillRestored(messages: readonly unknown[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "custom" || message.customType !== RESTORED_SCHEMAS_TYPE) continue;
		const tools = isRecord(message.details) ? message.details.tools : undefined;
		if (Array.isArray(tools)) for (const name of tools) if (typeof name === "string") names.add(name);
	}
	return names;
}

/** The text of a tool result made of text parts. */
function resultText(message: Record<string, unknown>): string {
	if (!Array.isArray(message.content)) return "";
	return message.content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
}

/**
 * The tools whose full schema a tool result among `messages` already shows: a refused call (compact JSON) or the `mcp`
 * tool's `tools` intent (indented JSON).
 */
function schemaInResults(messages: readonly unknown[], declared: readonly DeclaredTool[]): Set<string> {
	const texts = messages.flatMap((message) =>
		isRecord(message) && message.role === "toolResult" ? [resultText(message)] : [],
	);
	const names = new Set<string>();
	if (texts.length === 0) return names;
	for (const tool of declared) {
		const schema = deferredInputSchema(tool.parameters);
		if (schema === undefined) continue;
		const forms = [JSON.stringify(schema), JSON.stringify(schema, null, 2)];
		if (texts.some((text) => forms.some((form) => text.includes(form)))) names.add(tool.name);
	}
	return names;
}

interface DeclaredTool {
	name: string;
	parameters: unknown;
}

/**
 * The message that restores the schemas of the deferred tools among `called` (in that order): a tool counts when the
 * session declares it deferred (`deferredInputSchema` of its declared parameters) and it is active. A schema that does
 * not fit what is left of `budget` is left out whole (`omitted`), never cut: the tool stays callable and a refused call
 * returns its schema. Undefined when no schema is restored.
 */
export function restoredSchemas(
	declared: readonly DeclaredTool[],
	active: readonly string[],
	called: readonly string[],
	budget: number,
): { content: string; tools: string[]; omitted: string[] } | undefined {
	const byName = new Map(declared.map((tool) => [tool.name, tool]));
	const intro = renderPrompt("notices/compaction/restored-schemas.md").trim();
	const picked: Array<{ name: string; block: string }> = [];
	const omitted: string[] = [];
	let left = budget - intro.length;
	for (const name of called) {
		const schema = active.includes(name) ? deferredInputSchema(byName.get(name)?.parameters) : undefined;
		if (schema === undefined) continue;
		const block = `${name}\n${JSON.stringify(schema)}`;
		if (block.length + 2 > left) {
			omitted.push(name);
			continue;
		}
		left -= block.length + 2;
		picked.push({ name, block });
	}
	// Chosen by recency, rendered by name: the same tools give the same bytes whatever the call order.
	picked.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const tools = picked.map((entry) => entry.name);
	return tools.length > 0
		? { content: [intro, ...picked.map((entry) => entry.block)].join("\n\n"), tools, omitted }
		: undefined;
}

type RestoreContext = Pick<FeatureContext, "sessionManager"> & Partial<Pick<FeatureContext, "model">>;

/** Sends the schemas of the deferred tools this session called back into the context; returns the tools restored. */
export async function restoreDeferredSchemas(
	api: SetupPick<"session", "sendMessage"> & SetupPick<"tools", "getAll" | "getActive">,
	ctx: RestoreContext,
): Promise<string[]> {
	try {
		const branch = ctx.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const called = calledTools(branch);
		if (called.length === 0) return [];
		// A compaction whose tail already shows a schema (an earlier restore or a tool result) does not repeat it.
		const kept = contextMessages(ctx).map((entry) => entry.message);
		const shown = stillRestored(kept);
		for (const name of schemaInResults(kept, api.tools.getAll())) shown.add(name);
		const window = ctx.model?.contextWindow;
		const budget =
			typeof window === "number" && Number.isFinite(window) && window > 0
				? Math.min(RESTORE_SCHEMAS_CHARS, Math.floor(window * CHARS_PER_TOKEN * RESTORE_SCHEMAS_SHARE))
				: RESTORE_SCHEMAS_CHARS;
		const restored = restoredSchemas(
			api.tools.getAll(),
			api.tools.getActive(),
			called.filter((name) => !shown.has(name)),
			budget,
		);
		if (!restored) return [];
		const details = {
			tools: restored.tools,
			...(restored.omitted.length > 0 ? { omitted: restored.omitted } : {}),
		};
		await api.session.sendMessage(
			{ customType: RESTORED_SCHEMAS_TYPE, content: restored.content, display: false, details },
			{ triggerTurn: false },
		);
		return restored.tools;
	} catch (error) {
		// Octocode's ctx and api throw this once the session was replaced; any other failure is a real error and goes on.
		if (isStaleSessionError(error)) return [];
		throw error;
	}
}

/** After every compaction, the schemas of the deferred tools the session called follow the summary. */
export function registerDeferredSchemaRestore(api: FeatureSetup): void {
	api.bus.on("session_compact", async (_event, ctx) => {
		await restoreDeferredSchemas(api, ctx);
	});
}
