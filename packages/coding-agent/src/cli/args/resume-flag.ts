import type { FlagSpec } from "./types.ts";

/** A session id (UUID, or a prefix of one) or a session file path; anything else after `--resume` is the prompt. */
const looksLikeSessionRef = (word: string) =>
	/^[0-9a-f][0-9a-f-]{3,}$/i.test(word) || word.includes("/") || word.includes("\\") || word.endsWith(".jsonl");

/** `--resume <id>` opens the session exactly as `--session <id>` does; bare `--resume` opens the picker. */
export const RESUME_FLAG: FlagSpec = {
	name: "--resume",
	short: "-r",
	kind: "optional",
	arg: "[id]",
	completion: "text",
	help: [
		"Resume session <id> (id, unique id prefix or file path, like --session); without one, pick from a list",
		"A bare word is read as the id only when it looks like one (hex and dashes, or a path); use --session for other ids",
	],
	takesNext: looksLikeSessionRef,
	apply: (a, v) => {
		if (v === undefined) {
			a.resume = true;
			return undefined;
		}
		if (a.session !== undefined && a.session !== v) return "conflicts with --session given earlier";
		a.session = v;
		return undefined;
	},
};
