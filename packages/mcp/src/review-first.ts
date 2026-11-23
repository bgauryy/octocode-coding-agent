import { loadMcpConfig } from "./config.ts";

/**
 * Runs the security review over the servers configured now, before a new definition is written beside them. The
 * review's first run in a home approves the global servers it finds there, once: they predate the review. A definition
 * added before that run would be swept into that step too; run first, the step covers only the older servers, and the
 * new one stays not checked until the user approves it. In a home the review already ran in, this changes nothing.
 */
export function reviewBeforeAdding(options: { agentDir: string; cwd: string }): void {
	loadMcpConfig({ agentDir: options.agentDir, cwd: options.cwd, projectTrusted: false });
}
