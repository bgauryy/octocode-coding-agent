/**
 * The tool names the generic layers (system prompt, permission gate, hooks, profiles) reason about, and the groups they
 * form, in one place so a tool is renamed or added here and nowhere else. Octocode ships `file` for every change and the
 * MCP readers for every read.
 */

/** The shell tool and the file-change tool. */
export const BASH_TOOL = "bash";
export const FILE_TOOL = "file";
