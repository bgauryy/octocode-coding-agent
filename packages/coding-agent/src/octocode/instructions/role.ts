import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, shortHash } from "../../../../common/src/atomic-file.ts";
import { PRIVATE_FILE_MODE } from "../shared/home.ts";

export const ROLE_PROMPT_FILE_ENV = "OCTOCODE_ROLE_PROMPT_FILE";

/** Preserve the selected profile bytes independently of the user's APPEND_SYSTEM.md. */
export function writeRolePrompt(prompt: string, dir: string): string {
	const file = path.join(dir, `role-prompt-${shortHash(prompt)}.md`);
	atomicWriteFileSync(file, prompt, { mode: PRIVATE_FILE_MODE });
	return file;
}

/** Read once when the child starts; a missing handoff must not silently lose its instructions. */
export function readRolePrompt(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const file = env[ROLE_PROMPT_FILE_ENV];
	return file ? fs.readFileSync(file, "utf8") : undefined;
}
