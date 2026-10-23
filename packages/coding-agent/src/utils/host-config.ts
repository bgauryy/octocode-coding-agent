import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function claudeConfigDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, ".claude");
}

export function codexConfigDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
	if (!env.CODEX_HOME) return join(home, ".codex");
	try {
		const directory = realpathSync(env.CODEX_HOME);
		if (statSync(directory).isDirectory()) return directory;
	} catch {}
	throw new Error("CODEX_HOME must resolve to an existing directory");
}
