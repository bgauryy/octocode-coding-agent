/**
 * Claude Code's names for Octocode's tools. Two surfaces use them and each adds its own entries on top of this base:
 * - hooks (`hooks/config/calls.ts`): the `tool_name` a hook receives and the names a `"matcher"` such as `Edit|Write`
 *   matches. Extras: `file` also answers to MultiEdit, `agent` is Claude Code's Task.
 * - permission rules (`permission/source-policy/rules.ts`): the tool names in `permissions.allow/ask/deny` rules.
 *   Extras: `file` also covers Delete, `bash` also PowerShell on Windows, `powershell`, and `agent` is Agent plus the
 *   `agent.*` session operations.
 * The two surfaces differ on purpose, so each keeps its own table; this one holds what they agree on.
 */

/** The single Claude Code tool a native file tool stands for. */
export const CLAUDE_FILE_TOOL_NAMES = { read: "Read", edit: "Edit", write: "Write" } as const;

/** Names both surfaces give an Octocode tool. */
export const CLAUDE_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
	bash: ["Bash"],
	read: [CLAUDE_FILE_TOOL_NAMES.read],
	edit: [CLAUDE_FILE_TOOL_NAMES.edit],
	write: [CLAUDE_FILE_TOOL_NAMES.write],
	grep: ["Grep"],
	find: ["Glob"],
	ls: ["LS"],
	web: ["WebFetch", "WebSearch"],
};
