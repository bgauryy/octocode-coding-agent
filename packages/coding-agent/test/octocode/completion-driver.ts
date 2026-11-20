import fs from "node:fs";
import path from "node:path";
import { fakeHost } from "./fake-host.ts";
import octocode from "../../src/octocode/index.ts";
import { tmp } from "./helpers.ts";

type Completer = (prefix: string) => Array<{ value: string }> | null | Promise<Array<{ value: string }> | null>;

/** Every native command the way the session registers it, composed against an isolated home. Restores the environment on `dispose`. */
export async function registeredCommands(): Promise<{
	commands: Map<string, { argumentWords?: readonly string[]; getArgumentCompletions?: Completer }>;
	cwd: string;
	dispose(): void;
}> {
	const root = fs.realpathSync(tmp("octocode-completion-"));
	const saved = { ...process.env };
	Object.assign(process.env, {
		HOME: path.join(root, "home"),
		OCTOCODE_HOME: path.join(root, "home", ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: path.join(root, "agent"),
		OCTOCODE_AGENT_DB: path.join(root, "agent.sqlite"),
	});
	const fake = fakeHost();
	Object.assign(fake.api.session, { getName: () => undefined });
	await octocode(fake.api);
	return {
		commands: fake.commands,
		cwd: root,
		dispose: () => {
			process.env = saved;
		},
	};
}

/**
 * Drives a command's completion the way the editor does: the first-level words, then each word followed by a space and
 * by a letter. Returns every value that answers a second-level argument without the words before it, because picking it
 * would replace the whole argument text with only that value.
 */
export async function droppedLeadingWords(command: {
	argumentWords?: readonly string[];
	getArgumentCompletions?: Completer;
}): Promise<string[]> {
	const complete = command.getArgumentCompletions;
	if (!complete) return [];
	const first = await complete("");
	const words = new Set([...(command.argumentWords ?? []), ...(first ?? []).map((item) => item.value.trim())]);
	const dropped: string[] = [];
	for (const word of words) {
		for (const typed of [`${word} `, `${word} a`, `${word} e`]) {
			for (const item of (await complete(typed)) ?? []) {
				if (!item.value.startsWith(`${word} `)) dropped.push(`${typed} -> ${item.value}`);
			}
		}
	}
	return dropped;
}
