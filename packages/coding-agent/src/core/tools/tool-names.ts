/**
 * The tool names the generic layers (system prompt, permission gate, hooks, profiles) reason about, and the groups they
 * form, in one place so a tool is renamed or added here and nowhere else. Octocode ships `file` for every change and the
 * MCP readers for every read; the names below are the same-named tools a custom tool or SDK caller may still register
 * (core's readers and editors), which stay classified, gated and hooked like the originals.
 */

/** The shell tool, the file-change tool and the skill loader. */
export const BASH_TOOL = "bash";
export const FILE_TOOL = "file";
export const SKILL_TOOL = "skill";
/** Core's file reader: Octocode ships none, but an SDK session may register one. */
export const READ_TOOL = "read";

/** Readers that take `path`; `grep`, `find` and `ls` default to the working directory. */
export const LEGACY_READ_TOOLS: readonly string[] = [READ_TOOL, "grep", "find", "ls"];

/** File changers that take `path` (Octocode's own `file` tool checks itself). */
export const LEGACY_CHANGE_TOOLS: readonly string[] = ["edit", "write"];

/** Tools whose call input names the one file they act on: the single-path readers and changers. */
export const PATH_INPUT_TOOLS: readonly string[] = [READ_TOOL, ...LEGACY_CHANGE_TOOLS];

/**
 * Built-in tools renamed in the last release, old name to current. A selection that names the old one (`--tools`,
 * `--exclude-tools`, the SDK options, the `defaultTools` setting, a profile's `tools`/`excludeTools`, a resumed
 * transcript's loadout) selects the current one, and an old transcript's calls render with it (`currentToolName`).
 * The current tool keeps exactly one registered name; drop an entry one release after its rename.
 */
export const RENAMED_TOOLS: Readonly<Record<string, string>> = { task: "steps" };

/** Every tool that can change a workspace file: `file` and the legacy changers. */
export const FILE_CHANGING_TOOLS: readonly string[] = [FILE_TOOL, ...LEGACY_CHANGE_TOOLS];
