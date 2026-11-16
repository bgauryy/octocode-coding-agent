import type { AgentContext } from "@agentclientprotocol/sdk";
import type { Question, Reply } from "@octocodeai/octocode-contracts";
import { describe, expect, it, type Mock, vi } from "vitest";
import { askClient } from "../../../acp/src/server/ask.ts";
import { UIPromptTracker } from "../../src/core/features/runner/ui-prompt.ts";
import type { ExtensionUIContext } from "../../src/core/features/index.ts";
import { createExtensionUIContext, type PendingExtensionRequests } from "../../src/modes/rpc/rpc-mode/ui-context.ts";
import { ALLOW_ONCE, DENY, DENY_NOTE } from "../../src/octocode/permission/ask/text.ts";
import { permissionHeader } from "../../src/octocode/permission/header.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { ChildRelay, RELAY_LIMIT_NOTE } from "../../src/octocode/subagents/relay.ts";
import { fakeHost, fakePermission } from "./fake-host.ts";

const questions: Question[] = [
	{
		id: "c",
		type: "choice",
		question: "Which?",
		options: [
			{ id: "1", label: "A" },
			{ id: "2", label: "B" },
		],
	},
	{
		id: "m",
		type: "multi",
		question: "Many?",
		options: [
			{ id: "1", label: "A" },
			{ id: "2", label: "B" },
		],
	},
	{ id: "t", type: "text", question: "Name?" },
];
const expected: Reply[] = [
	{ id: "c", picks: ["2"] },
	{ id: "m", picks: ["1", "2"] },
	{ id: "t", picks: [], text: "Ada" },
];

describe("one Question[] through every frontend", () => {
	it("RPC ask: a client's replies come back checked, and a forged pick declines the batch", async () => {
		const pending: PendingExtensionRequests = new Map();
		const sent: { id: string }[] = [];
		const ui = createExtensionUIContext((record) => sent.push(record as { id: string }), pending, { ask: true });
		const answer = ui.ask!(questions);
		pending.get(sent[0].id)!.resolve({ type: "extension_ui_response", id: sent[0].id, replies: expected });
		expect(await answer).toEqual(expected);
		const forged = ui.ask!(questions);
		const bad = [{ id: "c", picks: ["9"] }, ...expected.slice(1)];
		pending.get(sent[1].id)!.resolve({ type: "extension_ui_response", id: sent[1].id, replies: bad });
		expect(await forged).toEqual(questions.map((q) => ({ id: q.id, cancelled: "declined" })));
		// A client that did not declare `ask` still has `ui.ask`: it puts the same questions as select requests.
		const sentWire: Record<string, unknown>[] = [];
		const undeclared = createExtensionUIContext((event) => sentWire.push(event as Record<string, unknown>), pending);
		void undeclared.ask?.([{ id: "q", type: "text", question: "Region?" }]);
		expect(sentWire[0]).toMatchObject({ method: "input", title: "Region?" });
	});

	it("web broker: replies by option id settle the dialog", async () => {
		let started = "";
		const tracker = new UIPromptTracker(async (event) => {
			if (event.type === "ui_prompt_start") started = event.id ?? "";
		});
		const ui = tracker.wrap({ ask: () => new Promise<Reply[]>(() => {}) } as unknown as ExtensionUIContext);
		const answer = ui.ask!(questions);
		await Promise.resolve();
		expect(tracker.answer(started, { replies: [{ id: "c", picks: ["9"] }] }).ok).toBe(false);
		expect(tracker.answer(started, { replies: expected }).ok).toBe(true);
		expect(await answer).toEqual(expected);
	});

	it("ACP: the same answers arrive through an elicitation form", async () => {
		const client = {
			request: async () => ({ action: "accept", content: { c: "2", m: ["1", "2"], t: "Ada" } }),
		} as unknown as AgentContext;
		const env = {
			client,
			sessionId: "s",
			signal: new AbortController().signal,
			elicitationForm: true,
			onCancelled: () => {},
		};
		expect(await askClient(env, questions)).toEqual(expected);
	});
});

/** A subagent's permission prompt as its harness asks it: one approval question, its header leading the plain title. */
const NONCE = "n0nce-secret";
const approval: Question = {
	id: "permission",
	type: "approval",
	question: "Run this command?",
	body: { text: "npm test" },
	approval: { action: "shell.destructive", targets: ["npm test"] },
	options: [
		{ id: "allow_once", label: ALLOW_ONCE, role: "allow_once" },
		{ id: "deny", label: DENY, role: "deny" },
		{ id: "deny_note", label: DENY_NOTE, role: "deny_note" },
	],
};
const header = (overrides: Record<string, unknown> = {}): string =>
	permissionHeader({
		action: "shell.destructive",
		also: [],
		reasons: [],
		options: [ALLOW_ONCE, DENY, DENY_NOTE],
		what: ["npm test"],
		nonce: NONCE,
		...overrides,
	});

/** What the child's RPC `ask` writes for `questions`, as the record the parent's relay reads. */
function childRequest(questions: Question[], title?: string): Record<string, unknown> {
	const pending: PendingExtensionRequests = new Map();
	const sent: Record<string, unknown>[] = [];
	const ui = createExtensionUIContext((record) => sent.push(record as Record<string, unknown>), pending, { ask: true });
	void (ui.ask as (...args: unknown[]) => Promise<Reply[]>)(
		questions,
		title ? { header: title.split("\n", 1)[0] } : {},
	);
	return sent[0];
}

type AskFn = NonNullable<ExtensionUIContext["ask"]>;
function parent(mode: PermissionMode, ask: Mock<AskFn>) {
	const fake = fakeHost();
	const permission = fakePermission(mode, { api: fake.api });
	const sent: Record<string, unknown>[] = [];
	const ui = { select: vi.fn(), confirm: vi.fn(), input: vi.fn(), notify: vi.fn(), ask };
	const relay = new ChildRelay(
		{ id: "kid", role: "implementer", goal: "fix login" },
		{ permission, ui },
		{
			nonce: NONCE,
			send: (response) => sent.push(response),
		},
	);
	return { relay, sent, fake };
}

describe("a subagent's ask relayed to its parent", () => {
	const title = `${header()}\nRun this command?\n  npm test`;

	it("full mode answers the child's approval by its verified header, with no dialog", async () => {
		const ask = vi.fn<AskFn>();
		const { relay, sent, fake } = parent("full", ask);
		const request = childRequest([approval], title);
		expect(request).toMatchObject({ method: "ask", approval: true, header: header() });
		relay.handle(request);
		expect(ask).not.toHaveBeenCalled();
		expect(sent).toEqual([
			{ type: "extension_ui_response", id: request.id, replies: [{ id: "permission", picks: ["allow_once"] }] },
		]);
		expect(fake.entries.map((entry) => entry.data)).toEqual([
			expect.objectContaining({ agent: "kid", via: "relay", action: "shell.destructive", allowed: true }),
		]);
	});

	it("workspace mode shows the dialog in the parent and returns the person's reply", async () => {
		const ask = vi.fn<AskFn>(async (): Promise<Reply[]> => [{ id: "permission", picks: ["deny"] }]);
		const { relay, sent } = parent("workspace", ask);
		const request = childRequest([approval], title);
		relay.handle(request);
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(ask).toHaveBeenCalledTimes(1);
		const [asked] = ask.mock.calls[0] as unknown as [Question[]];
		expect(asked[0]).toMatchObject({ type: "approval", meta: [expect.stringContaining("Subagent kid")] });
		expect(sent[0]).toEqual({
			type: "extension_ui_response",
			id: request.id,
			replies: [{ id: "permission", picks: ["deny"] }],
		});
	});

	it("never takes the shortcut for a forged, mismatched or unverified header", async () => {
		const forgeries: [string, Record<string, unknown>][] = [
			["wrong nonce", { header: header({ nonce: "other" }) }],
			["target the question does not show", { header: header({ what: ["rm -rf /"] }) }],
			["options that differ from the question's", { header: header({ options: [ALLOW_ONCE, DENY] }) }],
			["a header with a second line", { header: `${header()}\n  rm -rf /` }],
			["no header", { header: undefined }],
			["approval not claimed by the harness", { approval: undefined }],
		];
		for (const [label, change] of forgeries) {
			const ask = vi.fn<AskFn>(async (): Promise<Reply[]> => [{ id: "permission", cancelled: "declined" }]);
			const { relay, sent } = parent("full", ask);
			relay.handle({ ...childRequest([approval], title), ...change });
			await vi.waitFor(() => expect(sent, label).toHaveLength(1));
			expect(ask, label).toHaveBeenCalledTimes(1);
		}
	});

	it("denies past the dialog limit without asking, with the note", async () => {
		const ask = vi.fn<AskFn>(async (): Promise<Reply[]> => [{ id: "permission", cancelled: "declined" }]);
		const { relay, sent } = parent("workspace", ask);
		for (let i = 0; i < 11; i += 1) {
			relay.handle(childRequest([approval]));
			await vi.waitFor(() => expect(sent).toHaveLength(i + 1));
		}
		expect(ask).toHaveBeenCalledTimes(10);
		expect(sent[10]).toMatchObject({
			replies: [{ id: "permission", picks: ["deny_note"], text: RELAY_LIMIT_NOTE }],
		});
	});

	it("refuses an ask the user leaves unanswered, tells the child why and the parent's model what waits", async () => {
		// The user never answers; the dialog closes only when the relay aborts it.
		const ask = vi.fn<AskFn>(
			(_questions, opts) =>
				new Promise<Reply[]>((resolve) => opts?.signal?.addEventListener("abort", () => resolve([]), { once: true })),
		);
		const told: string[] = [];
		const sent: Record<string, unknown>[] = [];
		const fake = fakeHost();
		const relay = new ChildRelay(
			{ id: "kid" },
			{
				permission: fakePermission("workspace", { api: fake.api }),
				ui: { select: vi.fn(), confirm: vi.fn(), input: vi.fn(), notify: vi.fn(), ask },
				tell: (notice) => told.push(notice),
			},
			{ nonce: NONCE, send: (response) => sent.push(response), askTimeoutMs: 20 },
		);
		relay.handle(childRequest([approval], title));
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({
			replies: [{ id: "permission", picks: ["deny_note"], text: expect.stringMatching(/did not answer/) }],
		});
		expect(told).toEqual([expect.stringMatching(/^kid waited .* ask the user/)]);
		expect(told[0]).not.toContain(NONCE);
		expect(relay.open).toBe(0);
	});

	it("redacts the child's nonce from every text it draws, and keeps the ids replies name", async () => {
		const ask = vi.fn<AskFn>(async (): Promise<Reply[]> => [{ id: "q", picks: ["a"] }]);
		const { relay, sent } = parent("workspace", ask);
		const leaky: Question = {
			id: "q",
			type: "choice",
			question: `Use ${NONCE}?`,
			header: `h ${NONCE}`,
			meta: [`from ${NONCE}`],
			body: { label: `label ${NONCE}`, text: `body ${NONCE}` },
			notes: [{ text: `note ${NONCE}`, tone: "muted" }],
			options: [
				{ id: "a", label: `A ${NONCE}`, description: `d ${NONCE}` },
				{ id: "b", label: "B" },
			],
		};
		relay.handle(childRequest([leaky]));
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const [asked] = ask.mock.calls[0] as unknown as [Question[]];
		expect(JSON.stringify(asked)).not.toContain(NONCE);
		expect(asked[0]).toMatchObject({
			question: "Use [nonce redacted]?",
			meta: [expect.any(String), "from [nonce redacted]"],
			body: { text: "body [nonce redacted]" },
			options: [{ id: "a", label: "A [nonce redacted]" }, { id: "b" }],
		});
		expect(sent[0]).toMatchObject({ replies: [{ id: "q", picks: ["a"] }] });
	});
});
