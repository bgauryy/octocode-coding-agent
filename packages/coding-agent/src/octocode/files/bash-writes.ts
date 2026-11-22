import fs from "node:fs";
import { shellPath } from "../permission/file-access.ts";
import { shellMutation, shellParserReady } from "../permission/shell/mutation.ts";

/**
 * The existing regular files a plain `bash` command wrote, as its parse shows them (redirections, `tee`, `cp` and the
 * like: `shellMutation().writes`). The file tool counts them as read by this session: the session made their content,
 * and a change by another writer afterwards still shows in the stat the guard compares. A command whose writes the
 * parse cannot name (`node script.js`) credits nothing, and neither does a path that does not resolve to a file.
 */
export async function shellWrittenFiles(command: string, cwd: string): Promise<string[]> {
	await shellParserReady();
	const files: string[] = [];
	for (const raw of shellMutation(command).writes) {
		const file = shellPath(cwd, raw);
		try {
			if (fs.statSync(file).isFile()) files.push(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return files;
}
