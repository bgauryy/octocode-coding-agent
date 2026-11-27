import { describe, expect, it } from "vitest";
import {
	assignmentText,
	IDENTITY_ENTRY,
	IDENTITY_REMINDER_TYPE,
	registerIdentityReminder,
	SUBAGENT_ASSIGNMENT_ENV,
} from "../../src/octocode/subagents/identity-reminder.ts";
import { childTaskInput } from "../../src/octocode/subagents/task-text.ts";
import { identityBlock, withIdentity } from "../../src/octocode/native/prompts/task.ts";
import { AGENT_ID_ENV } from "../../src/octocode/team/store/env.ts";
import { asSetup } from "./fake-host.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** A child session as the reminder sees it: its branch of entries, the handlers it registered and what it sent. */
function child(env: NodeJS.ProcessEnv, sendError?: Error, rejects = false) {
	const branch: Array<{ type: string; customType?: string; data?: unknown }> = [];
	const handlers = new Map<string, Handler>();
	const sent: Array<{ message: Record<string, unknown>; options: unknown }> = [];
	const api = asSetup({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		sendMessage: (message: Record<string, unknown>, options: unknown) => {
			// A session write that fails after the call returned rejects; a replaced session throws at the call.
			if (sendError && rejects) return Promise.reject(sendError);
			if (sendError) throw sendError;
			sent.push({ message, options });
			return undefined;
		},
	});
	registerIdentityReminder(api, env);
	const ctx = { sessionManager: { getBranch: () => branch } };
	return {
		branch,
		sent,
		emit: (name: string) => handlers.get(name)?.({}, ctx),
		add: (entry: { type: string; customType?: string; data?: unknown }) => branch.push(entry),
	};
}

const contractA = { hash: "a".repeat(64), schema: { type: "object", properties: { a: { type: "string" } } } };
const identityA = {
	id: "kid",
	role: "implementer",
	goal: "Goal A",
	parentId: "boss",
	scratch: "/tmp/scratch/kid",
	item: "B1",
	isolation: { path: "/wt/kid", repo: "/repo", cwd: "/wt/kid/pkg" },
	background: true,
};
const identityB = { ...identityA, goal: "Goal B", item: "B2", background: false };
const parts = (resultContract?: typeof contractA) => ({
	browserMode: undefined,
	skillText: '## Skills\n<skill name="x" location="/s/x/SKILL.md"/>',
	resultContract: resultContract as never,
});

describe("child identity reminder after compaction", () => {
	it("renders the identity, skill pointers and result contract with their owning renderers", () => {
		const text = assignmentText(identityA, undefined, parts(contractA), false);
		const block = identityBlock(identityA);
		expect(text.startsWith(block)).toBe(true);
		// The task the child got ends with the same contract text the reminder carries.
		const task = childTaskInput("do it", { referenced: "", ...parts(contractA) });
		expect(text).toContain(task.slice(task.indexOf("## Skills")));
		expect(withIdentity(task, identityA)).toContain(block);
		for (const line of ["/wt/kid/pkg", "B1", "done", "blocked", "Result contract (SHA-256 aaaa"])
			expect(text).toContain(line);
		// Inlined skill bodies are not repeated.
		expect(assignmentText(identityA, undefined, parts(contractA), true)).not.toContain("## Skills");
	});

	it("records each new assignment once and re-sends the latest after a compaction, hidden at the tail", async () => {
		const textA = assignmentText(identityA, undefined, parts(contractA), false);
		const textB = assignmentText(identityB, undefined, parts(), false);
		const env: NodeJS.ProcessEnv = { [AGENT_ID_ENV]: "kid", [SUBAGENT_ASSIGNMENT_ENV]: textA };
		const first = child(env);
		await first.emit("session_start");
		await first.emit("session_start");
		expect(first.branch).toHaveLength(1);
		// A task resume with assignment B (a new process on the same session), then a compaction.
		env[SUBAGENT_ASSIGNMENT_ENV] = textB;
		const resumed = child(env);
		for (const entry of first.branch) resumed.add(entry);
		resumed.add({ type: "custom", customType: IDENTITY_ENTRY, data: { version: 1, id: "other", text: "not mine" } });
		await resumed.emit("session_start");
		await resumed.emit("session_compact");
		expect(resumed.sent).toHaveLength(1);
		const { message, options } = resumed.sent[0];
		expect(message).toMatchObject({ customType: IDENTITY_REMINDER_TYPE, display: false, content: textB });
		expect(options).toEqual({ triggerTurn: false });
		for (const gone of ["Goal A", "B1", "Result contract"]) expect(String(message.content)).not.toContain(gone);
		for (const kept of ["kid", "boss", "/wt/kid/pkg", "Goal B", "B2"]) expect(String(message.content)).toContain(kept);
	});

	it("sends nothing without a recorded assignment, and swallows only a replaced session's error", async () => {
		const none = child({ [AGENT_ID_ENV]: "kid" });
		await none.emit("session_start");
		await none.emit("session_compact");
		expect(none.sent).toHaveLength(0);
		const env = { [AGENT_ID_ENV]: "kid", [SUBAGENT_ASSIGNMENT_ENV]: "identity" };
		const stale = child(env, new Error("ctx is stale after session replacement"));
		await stale.emit("session_start");
		await expect(stale.emit("session_compact")).resolves.toBeUndefined();
		const broken = child(env, new Error("disk full"));
		await broken.emit("session_start");
		await expect(broken.emit("session_compact")).rejects.toThrow("disk full");
		// The send is awaited: a rejection reaches the bus's error report instead of no one.
		const failing = child(env, new Error("write failed"), true);
		await failing.emit("session_start");
		await expect(failing.emit("session_compact")).rejects.toThrow("write failed");
	});
});
