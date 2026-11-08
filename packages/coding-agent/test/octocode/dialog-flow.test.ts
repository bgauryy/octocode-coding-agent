import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { UIPromptTracker } from "../../src/core/features/runner/ui-prompt.ts";
import type { Question } from "@octocodeai/octocode-contracts";
import type { ExtensionContext, ExtensionUIContext } from "../../src/core/features/types.ts";
import { createExtensionUIContext, type PendingExtensionRequests } from "../../src/modes/rpc/rpc-mode/ui-context.ts";
import { degrade } from "../../src/octocode/ask/degrade.ts";
import { externalPermissionDialog } from "../../src/octocode/external/permission-dialog.ts";
import { selectAnswer } from "../../src/octocode/permission/ask/text.ts";
import { ChildRelay } from "../../src/octocode/subagents/relay.ts";
import { awaitingFor, registerAwaiting } from "../../src/octocode/ui/awaiting.ts";
import { SessionWatch } from "../../src/octocode/web-daemon/session-state.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const services: Array<{ dispose(): void }> = [];
const watches: SessionWatch[] = [];
afterEach(() => {
	for (const watch of watches.splice(0)) watch.close();
	for (const service of services.splice(0)) service.dispose();
});

type Started = { type: "ui_prompt_start" | "ui_prompt_end"; [key: string]: unknown };

/** An RPC host's UI behind the broker, as the runner wires it: what the host sees and what extensions are told. */
function rpcSide(onEvent: (event: Started) => void = () => undefined) {
	const pending: PendingExtensionRequests = new Map();
	const output: Array<Record<string, unknown>> = [];
	const tracker = new UIPromptTracker(async (event) => onEvent(event as unknown as Started));
	const ui = tracker.wrap(createExtensionUIContext((value) => output.push(value as Record<string, unknown>), pending));
	const events: Started[] = [];
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	return { pending, output, tracker, ui, events, flush };
}

const request = (output: Array<Record<string, unknown>>, method: string) =>
	output.find((item) => item.type === "extension_ui_request" && item.method === method);

describe("permission prompts are approvals", () => {
	it("publishes the native gate's dialog as an approval, and its note as a question", async () => {
		const events: Started[] = [];
		const tracker = new UIPromptTracker(async (event) => void events.push(event as unknown as Started));
		// The dialog queue is shared (an approval is asked through it): the dialogs close with their signal.
		const controller = new AbortController();
		const never = (_title: string, _options: unknown, opts?: { signal?: AbortSignal }) =>
			new Promise<undefined>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined)));
		const plain = { select: never, input: never, confirm: async () => false };
		const ui = tracker.wrap({
			...plain,
			ask: (questions: Question[], opts?: object) => degrade(plain, questions, opts),
		} as unknown as ExtensionUIContext);
		const ctx = { hasUI: true, ui } as unknown as Parameters<typeof selectAnswer>[0];
		const answered = selectAnswer(
			ctx,
			{ title: "Run command?", what: ["git status"], action: "shell", signal: controller.signal },
			"manual",
			false,
			"",
		);
		await vi.waitFor(() => expect(events).toHaveLength(1));
		const start = events[0];
		expect(start).toMatchObject({ type: "ui_prompt_start", kind: "ask", approval: true });
		expect(awaitingFor(start as never).kind).toBe("approval");
		// The note rides in the reply: one prompt, no second input dialog.
		expect(
			tracker.answer(start.id as string, { replies: [{ id: "permission", picks: ["deny_note"], text: "later" }] }),
		).toEqual({ ok: true });
		expect(await answered).toEqual({ deny: "later" });
		expect(events.filter((event) => event.kind === "input")).toHaveLength(0);
	});

	it("publishes an external agent's permission request as a blocking approval", async () => {
		const events: Started[] = [];
		const tracker = new UIPromptTracker(async (event) => void events.push(event as unknown as Started));
		const ui = {
			// The dialog queue is shared: this dialog must close with its signal so later tests are not queued behind it.
			select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
				new Promise<undefined>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined))),
			ask: (questions: Question[], opts?: object) =>
				degrade(
					{
						select: (_title: string, _options: string[], o?: { signal?: AbortSignal }) =>
							new Promise<undefined>((resolve) => o?.signal?.addEventListener("abort", () => resolve(undefined))),
					} as never,
					questions,
					opts,
				),
		} as unknown as ExtensionUIContext;
		const ctx = { hasUI: true, mode: "tui", ui: tracker.wrap(ui) } as unknown as ExtensionContext;
		const controller = new AbortController();
		void externalPermissionDialog(ctx)(
			{
				sessionId: "external",
				toolCall: { toolCallId: "call", title: "Run it" },
				options: [
					{ optionId: "one", name: "Proceed", kind: "allow_once" },
					{ optionId: "no", name: "Stop", kind: "reject_once" },
				],
			},
			controller.signal,
		);
		await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
		expect(events[0]).toMatchObject({ type: "ui_prompt_start", kind: "ask", approval: true, blocking: true });
		controller.abort();
		await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "ui_prompt_end" }));
	});
});

describe("RPC dialogs a client did not answer", () => {
	it("tells the RPC host to close a dialog another client answered", async () => {
		const side = rpcSide((event) => side.events.push(event));
		const answered = side.ui.select("Run?", ["Allow once", "Deny"]);
		const asked = request(side.output, "select")!;
		expect(asked).not.toHaveProperty("approval");
		await side.flush();
		const dialogId = side.events.find((event) => event.type === "ui_prompt_start")!.id as string;
		expect(side.tracker.answer(dialogId, { choice: "Deny" })).toEqual({ ok: true });
		expect(await answered).toBe("Deny");
		expect(side.output.filter((item) => item.type === "extension_ui_dismiss")).toEqual([
			{ type: "extension_ui_dismiss", id: asked.id },
		]);
		expect(side.pending.size).toBe(0);
	});

	it("dismisses on abort and on timeout, but not after the host's own response", async () => {
		const side = rpcSide();
		const controller = new AbortController();
		const aborted = side.ui.confirm("Go?", "msg", { signal: controller.signal });
		controller.abort();
		expect(await aborted).toBe(false);
		const timed = side.ui.input("Name?", undefined, { timeout: 10 });
		expect(await timed).toBeUndefined();
		const answered = side.ui.select("Pick", ["a"]);
		const asked = request(side.output, "select")!;
		side.pending
			.get(asked.id as string)!
			.resolve({ type: "extension_ui_response", id: asked.id as string, value: "a" });
		expect(await answered).toBe("a");
		const dismissed = side.output.filter((item) => item.type === "extension_ui_dismiss");
		expect(dismissed).toHaveLength(2);
		expect(dismissed.map((item) => item.id)).not.toContain(asked.id);
	});
});

describe("dialogs relayed from a subagent", () => {
	function parent() {
		// `fakeCtx` answers every session lookup with the id "session-test"; the parent is idle.
		const session = {
			sessionId: "session-test",
			messages: [],
			isStreaming: false,
			subscribe: () => () => undefined,
		} as unknown as AgentSession;
		const service = getApplicationPort(session);
		services.push(service);
		const fake = fakeHost();
		registerAwaiting(fake.api);
		const idle = fakeCtx({ cwd: "/x", idle: true });
		const open = new Map<string, (value: unknown) => void>();
		const plainUi = {
			select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
				new Promise<string | undefined>((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
			input: async () => undefined,
			confirm: async () => false,
		} as unknown as ExtensionUIContext;
		const ui = {
			select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
				new Promise<string | undefined>((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
			confirm: async () => false,
			input: async () => undefined,
			notify: () => undefined,
			ask: (questions: Question[], opts?: object) => degrade(plainUi, questions, opts),
		} as unknown as ExtensionUIContext;
		const tracker = new UIPromptTracker(async (event) => {
			await fake.emit(event.type, event, idle);
		});
		const sent: Array<Record<string, unknown>> = [];
		const waiting: boolean[] = [];
		const relay = new ChildRelay(
			{ id: "child-1" },
			{
				permission: { allows: () => false, relayedAllow: vi.fn(), adopt: vi.fn(), relayNote: vi.fn() },
				ui: tracker.wrap(ui),
			},
			{ nonce: "", send: (response) => sent.push(response), onWaiting: (value) => waiting.push(value) },
		);
		return { service, tracker, relay, sent, waiting, open, fake, idle };
	}
	/** A child's `ask` event: one question; `approval` marks it a permission prompt the child's harness vouched for. */
	const ask = (relay: ChildRelay, extra: { approval?: true } = {}) =>
		relay.handle({
			type: "extension_ui_request",
			method: "ask",
			id: "c1",
			questions: [
				extra.approval
					? {
							id: "permission",
							type: "approval",
							question: "Run rm -rf build?",
							approval: { action: "shell", targets: ["rm -rf build"] },
							options: [
								{ id: "allow_once", label: "Allow once", role: "allow_once" },
								{ id: "deny", label: "Deny", role: "deny" },
							],
						}
					: {
							id: "q",
							type: "choice",
							question: "Which one?",
							options: [
								{ id: "a", label: "A" },
								{ id: "b", label: "B" },
							],
						},
			],
			...extra,
		});

	it("publishes an approval while the parent is idle, and the daemon's session list says the session needs you", async () => {
		const { service, tracker, relay, sent } = parent();
		const changed = vi.fn();
		const watch = new SessionWatch(service, "session-test", changed);
		watches.push(watch);
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: false }));
		ask(relay, { approval: true });
		await vi.waitFor(() => expect(service.getSnapshot().awaiting).toBeDefined());
		const awaiting = service.getSnapshot().awaiting!;
		expect(awaiting).toMatchObject({ kind: "approval" });
		// The child's identity comes from the process (the relay's label), and rides on the question.
		expect(JSON.stringify(awaiting)).toContain("child-1 asks");
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: false, needsYou: awaiting.title }));
		expect(tracker.answer(awaiting.id!, { replies: [{ id: "permission", picks: ["allow_once"] }] })).toEqual({
			ok: true,
		});
		await vi.waitFor(() =>
			expect(sent).toEqual([
				{
					type: "extension_ui_response",
					id: "c1",
					replies: [{ id: "permission", picks: ["allow_once"] }],
				},
			]),
		);
		await vi.waitFor(() => expect(service.getSnapshot().awaiting).toBeUndefined());
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: false }));
	});

	it("keeps a relayed question a question, and keeps the wait after the parent's run settles", async () => {
		const { service, relay, fake, idle } = parent();
		ask(relay);
		await vi.waitFor(() => expect(service.getSnapshot().awaiting).toMatchObject({ kind: "question" }));
		await fake.emit("agent_settled", { aborted: false }, idle);
		expect(service.getSnapshot().awaiting).toMatchObject({ kind: "question" });
		relay.cancelAll();
		await vi.waitFor(() => expect(service.getSnapshot().awaiting).toBeUndefined());
	});

	it("closes the parent's dialog when the child dismisses its own, without answering the child", async () => {
		const { service, relay, sent, waiting } = parent();
		ask(relay, { approval: true });
		await vi.waitFor(() => expect(service.getSnapshot().awaiting).toBeDefined());
		relay.handle({ type: "extension_ui_dismiss", id: "c1" });
		expect(relay.open).toBe(0);
		await vi.waitFor(() => expect(service.getSnapshot().awaiting).toBeUndefined());
		expect(sent).toEqual([]);
		expect(waiting).toEqual([true, false]);
	});
});
