import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One owner starts a turn from an event: the event loop (`src/octocode/events/loop/`), reached through the wake intake
 * (`src/octocode/wake/`). Everything else either records context without a turn (no `triggerTurn`, or `triggerTurn: false`) or is on the short
 * list below, each with the reason it is not an event delivery. A new direct turn start fails here until it is routed
 * through `wakeGateOf(api).emit` or justified.
 */
const root = path.resolve(import.meta.dirname, "../../../src/octocode");
const OWNERS = ["events/loop/", "wake/"];

const DIRECT_SEND_ALLOWED: Record<string, string> = {
	"api/bridge/send.ts": "input from an external client or peer: a request, not a background event",
	"native/tools/compact/tool.ts": "the agent's own compact tool resumes the run it just compacted",
};
const USER_PROMPT_ALLOWED: Record<string, string> = {
	"plan/register.ts": "the user approved a plan or typed the command",
	"workspace/runtime.ts": "the web UI user's prompt",
	"backlog/command/item-actions.ts": "the user ran an item action",
	"cli/command.ts": "the user ran a command",
};

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) return sources(full);
		return full.endsWith(".ts") ? [full] : [];
	});
}

/** The text of each call to `needle(` up to its closing parenthesis. */
function calls(text: string, needle: string): string[] {
	const found: string[] = [];
	for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
		let depth = 0;
		let end = at + needle.length - 1;
		for (; end < text.length; end++) {
			if (text[end] === "(") depth++;
			if (text[end] === ")" && --depth === 0) break;
		}
		found.push(text.slice(at, end + 1));
	}
	return found;
}

const files = sources(root)
	.map((file) => ({ rel: path.relative(root, file), text: readFileSync(file, "utf8") }))
	.filter(({ rel }) => !OWNERS.some((owner) => rel.startsWith(owner)));

describe("who starts a turn from an event", () => {
	it("has no direct message send that may start a turn outside the loop and the short list", () => {
		const offenders = files.flatMap(({ rel, text }) =>
			calls(text, "session.sendMessage(")
				// A send starts a turn only when it says `triggerTurn` something other than false; without it, none starts.
				.filter((call) => call.includes("triggerTurn") && !call.includes("triggerTurn: false"))
				.filter(() => !(rel in DIRECT_SEND_ALLOWED))
				.map((call) => `${rel}: ${call.slice(0, 80)}`),
		);
		expect(offenders).toEqual([]);
	});

	it("has no user-prompt send outside the listed user actions", () => {
		const offenders = files
			.filter(({ rel, text }) => text.includes("session.sendUserMessage(") && !(rel in USER_PROMPT_ALLOWED))
			.map(({ rel }) => rel);
		expect(offenders).toEqual([]);
	});

	it("keeps the short lists current: each listed file still has the call it is allowed", () => {
		const has = (rel: string, needle: string) => files.some((file) => file.rel === rel && file.text.includes(needle));
		const stale = [
			...Object.keys(DIRECT_SEND_ALLOWED).filter((rel) => !has(rel, "session.sendMessage(")),
			...Object.keys(USER_PROMPT_ALLOWED).filter((rel) => !has(rel, "session.sendUserMessage(")),
		];
		expect(stale).toEqual([]);
	});
});
