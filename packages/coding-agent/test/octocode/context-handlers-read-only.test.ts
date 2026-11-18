import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { onlyReadsMessages } from "../../src/core/features/runner/clone-messages.ts";
import { attachBackend } from "../../src/octocode/claude-code/register.ts";
import octocode from "../../src/octocode/index.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../src/octocode/shared/messages.ts";
import { IDENTITY_REMINDER_TYPE } from "../../src/octocode/shared/reminder-view.ts";
import { registerIdentityReminder } from "../../src/octocode/subagents/identity-reminder.ts";
import { AGENT_ID_ENV } from "../../src/octocode/team/store/env.ts";
import { fakeCtx, fakeHost, asSetup } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * The built-in `context` handlers are declared with `readsMessagesOnly`, so a request hands them the transcript itself
 * instead of a copy. Each must then never edit a message: run on a deeply frozen transcript, an edit throws (modules are
 * strict) and the transcript stays as it was.
 */

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
	}
	return value;
}

/** A transcript that reaches every handler's branch: reminders, team mail, an untrusted result, thinking. */
function transcript() {
	return [
		{ role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 },
		{ role: "custom", customType: IDENTITY_REMINDER_TYPE, content: "old identity", display: false, timestamp: 2 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig" },
				{ type: "toolCall", id: "call-1", name: "web", arguments: { url: "https://example.com" } },
			],
			provider: "anthropic",
			model: "claude",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			stopReason: "toolUse",
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "web",
			content: [{ type: "text", text: "page text" }],
			isError: false,
			timestamp: 4,
		},
		{
			role: "custom",
			customType: INTERNAL_MESSAGE_TYPE,
			content: "mail",
			display: true,
			details: { messages: [{ id: 7, from: "boss", to: "kid", text: "hello" }] },
			timestamp: 5,
		},
		{ role: "custom", customType: IDENTITY_REMINDER_TYPE, content: "new identity", display: false, timestamp: 6 },
		{ role: "user", content: "next", timestamp: 7 },
	];
}

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	const home = tmp();
	process.env.OCTOCODE_HOME = home;
	process.env.OCTOCODE_AGENT_DB = path.join(home, "team.sqlite");
	delete process.env.OCTOCODE_SUBAGENT;
	closeSharedAgentDb();
});
afterEach(() => {
	closeSharedAgentDb();
	process.env = saved;
});

async function contextHandlers(): Promise<Array<{ owner: string; handler: Handler }>> {
	const fake = fakeHost();
	Object.assign(fake.api.session, { getName: () => undefined });
	await octocode(fake.api);
	const found = (fake.handlers.get("context") ?? []).map((handler) => ({
		owner: "octocode",
		handler: handler as Handler,
	}));
	const capture = (owner: string) =>
		asSetup({
			on: (event: string, handler: Handler) => {
				if (event === "context") found.push({ owner, handler });
			},
			registerProvider: () => {},
			appendEntry: () => {},
			sendMessage: () => {},
		});
	attachBackend(capture("claude-code"), { provider: {}, markTurn: () => {} } as never);
	registerIdentityReminder(capture("identity-reminder"), { [AGENT_ID_ENV]: "kid" });
	return found;
}

describe("built-in context handlers only read the transcript", () => {
	it("declares every one with readsMessagesOnly", async () => {
		const handlers = await contextHandlers();
		// Octocode's own: compaction (request view), hooks (message receive), team (mail seen); plus Claude Code and the
		// subagent identity reminder.
		expect(handlers.length).toBeGreaterThanOrEqual(5);
		expect(handlers.filter(({ handler }) => !onlyReadsMessages(handler)).map(({ owner }) => owner)).toEqual([]);
	});

	it("never edits a message, run on a deeply frozen transcript", async () => {
		const ctx = Object.assign(fakeCtx({ cwd: tmp(), hasUI: false, model: { provider: "claude-code", id: "x" } }), {
			getContextUsage: () => undefined,
		});
		for (const { owner, handler } of await contextHandlers()) {
			const messages = deepFreeze(transcript());
			const visible = messages.slice();
			const result = await handler({ type: "context", messages: visible, transcript: messages.slice() }, ctx).catch(
				(error: unknown) => ({ error }),
			);
			const error = (result as { error?: unknown } | undefined)?.error;
			expect(error, owner).toBeUndefined();
			expect(messages, owner).toEqual(transcript());
		}
	});

	it("would catch a handler that edits a message (the frozen transcript has teeth)", async () => {
		const editing: Handler = async (event) => {
			const [first] = (event as { messages: Array<{ content: Array<{ text: string }> }> }).messages;
			first.content[0].text = "edited";
		};
		const messages = deepFreeze(transcript());
		await expect(editing({ type: "context", messages: messages.slice() }, {})).rejects.toThrow(TypeError);
		expect(messages).toEqual(transcript());
	});
});
