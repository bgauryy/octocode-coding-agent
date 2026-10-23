import { parsePatch } from "../../shared/codex-patch/patch.ts";
import { fileChanges } from "../../shared/file-input.ts";
import type { HookHandler, HookConfig, HookEvent } from "../contracts.ts";
import { resolveToolPath } from "../../shared/home.ts";
import { isRecord, stringOrEmpty } from "../../shared/util.ts";
import { matchesHook } from "../profiles.ts";

/** Claude Code tool names for Octocode's tools, so `"matcher": "Bash"` or `"Edit|Write"` work unchanged. */
const CLAUDE_NAMES: Record<string, string[]> = {
	bash: ["Bash"],
	read: ["Read"],
	edit: ["Edit"],
	write: ["Write"],
	file: ["Edit", "Write", "MultiEdit"],
	grep: ["Grep"],
	find: ["Glob"],
	ls: ["LS"],
	web: ["WebFetch", "WebSearch"],
	agent: ["Task"],
};

export const toolAliases = (tool: string): string[] => [tool, ...(CLAUDE_NAMES[tool] ?? [])];

/** One hook dispatch: the matcher names, and the Claude Code `tool_name` / `tool_input` the hook receives on stdin. */
interface HookCall {
	names: string[];
	tool_name: string;
	tool_input: unknown;
}

/** One `file` query in Claude Code's shape: Edit / MultiEdit `{file_path, old_string, new_string | edits}`, Write `{file_path, content}`. */
function fileQueryCall(query: Record<string, unknown>, cwd: string): HookCall {
	const file_path = resolveToolPath(cwd, stringOrEmpty(query.path));
	if (query.type === "write")
		return {
			names: ["file", "Write"],
			tool_name: "Write",
			tool_input: { file_path, content: stringOrEmpty(query.content) },
		};
	if (query.type === "delete") return { names: ["file", "Delete"], tool_name: "Delete", tool_input: { file_path } };
	const edits = (Array.isArray(query.edits) ? query.edits : []).filter(isRecord).map((edit) => ({
		old_string: stringOrEmpty(edit.oldText),
		new_string: stringOrEmpty(edit.newText),
		...(typeof edit.replaceAll === "boolean" ? { replace_all: edit.replaceAll } : {}),
	}));
	if (edits.length === 1) return { names: ["file", "Edit"], tool_name: "Edit", tool_input: { file_path, ...edits[0] } };
	return { names: ["file", "MultiEdit"], tool_name: "MultiEdit", tool_input: { file_path, edits } };
}

/**
 * The hook dispatches for one Octocode tool call, with Claude Code's tool names and inputs so hooks written for Claude Code
 * (`jq .tool_input.file_path`, `"matcher": "Edit|Write"`) work unchanged: a `file` call is one dispatch per query
 * (Edit, MultiEdit, Write, or Delete, which Claude Code lacks); `read` and Octocode's `edit`/`write` send `file_path`;
 * `bash` already takes Claude's `{command}`. Other tools keep their Octocode name and input.
 */
export function hookCalls(tool: string, input: Record<string, unknown>, cwd: string): HookCall[] {
	if (
		tool === "file" &&
		typeof input.patch === "string" &&
		parsePatch(input.patch).hunks.some((h) => h.kind === "update")
	)
		return [];
	if (tool === "file") return fileChanges(input).map((query) => fileQueryCall(query, cwd));
	if (tool === "bash") return [{ names: toolAliases(tool), tool_name: "Bash", tool_input: input }];
	const claude = { read: "Read", edit: "Edit", write: "Write" }[tool];
	if (claude) {
		const { path: file, ...rest } = input;
		return [
			{
				names: toolAliases(tool),
				tool_name: claude,
				tool_input: { ...rest, file_path: resolveToolPath(cwd, stringOrEmpty(file)) },
			},
		];
	}
	return [{ names: toolAliases(tool), tool_name: tool, tool_input: input }];
}

/** Native whole-name matching remains available to callers of the legacy contract. */
export function matches(matcher: string, names: string[]): boolean {
	return matchesHook("octocode", "PreToolUse", matcher, names);
}

export function hookIdentity(hook: HookHandler): string {
	if (hook.type === "prompt")
		return JSON.stringify([
			hook.protocol,
			hook.plugin?.id ?? null,
			"prompt",
			hook.prompt,
			hook.model ?? null,
			hook.continueOnBlock ?? false,
		]);
	return JSON.stringify([
		hook.protocol ?? "octocode",
		hook.plugin?.id ?? null,
		...(hook.type === "http"
			? ["http", hook.url, hook.headers, hook.allowedEnvVars]
			: hook.type === "mcp_tool"
				? ["mcp_tool", hook.server, hook.tool, hook.input]
				: [
						"command",
						hook.command,
						hook.args ?? null,
						hook.commandWindows ?? null,
						hook.async ?? false,
						hook.asyncRewake ?? false,
						hook.protocol === "codex" ? (hook.additionalContextLimit ?? 2500) : null,
					]),
	]);
}

/** Select by profile; identical commands merge only within that profile, preserving required denial and source provenance. */
export function commandsFor(config: HookConfig, event: HookEvent, names: string[]): HookHandler[] {
	const unique = new Map<string, HookHandler>();
	for (const hook of config[event].flatMap((group) =>
		group.hooks.filter((hook) => matchesHook(hook.protocol ?? "octocode", event, group.matcher, names)),
	)) {
		const key = hookIdentity(hook);
		const first = unique.get(key);
		if (!first) unique.set(key, hook);
		else {
			const origins = [...(first.origins ?? []), ...(hook.origins ?? [])];
			unique.set(key, {
				...first,
				...(origins.length
					? { origins: [...new Map(origins.map((origin) => [JSON.stringify(origin), origin])).values()] }
					: {}),
				...(hook.failClosed || hook.configurationError ? { failClosed: true } : {}),
				...(hook.onFailure === "block" ? { onFailure: "block" as const } : {}),
				...(hook.configurationError ? { configurationError: hook.configurationError } : {}),
			});
		}
	}
	return [...unique.values()];
}
