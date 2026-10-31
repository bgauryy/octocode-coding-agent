import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { UIPromptTracker } from "../../src/core/extensions/runner/ui-prompt.ts";
import type { ExtensionContext, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { createExtensionUIContext, type PendingExtensionRequests } from "../../src/modes/rpc/rpc-mode/ui-context.ts";
import { externalPermissionDialog } from "../../src/octocode/external/permission-dialog.ts";
import { DENY_NOTE, selectAnswer } from "../../src/octocode/permission/ask/text.ts";
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
		const never = () => new Promise<undefined>(() => undefined);
		const ui = tracker.wrap({ select: never, input: never } as unknown as ExtensionUIContext);
		const ctx = { hasUI: true, ui } as unknown as Parameters<typeof selectAnswer>[0];
		void selectAnswer(ctx, { title: "Run command?", what: ["git status"], action: "shell" }, "manual", false, "");
		await vi.waitFor(() => expect(events).toHaveLength(1));
		const start = events[0];
		expect(start).toMatchObject({ type: "ui_prompt_start", kind: "select", approval: true });
		expect(awaitingFor(start as never).kind).toBe("approval");
		expect(tracker.answer(start.id as string, { choice: DENY_NOTE })).toEqual({ ok: true });
		await vi.waitFor(() => expect(events.filter((event) => event.kind === "input")).toHaveLength(1));
		const note = events.find((event) => event.type === "ui_prompt_start" && event.kind === "input")!;
		expect(note.approval).toBeUndefined();
		expect(awaitingFor(note as never).kind).toBe("question");
	});

	it("publishes an external agent's permission request as a blocking approval", async () => {
		const events: Started[] = [];
		const tracker = new UIPromptTracker(async (event) => void events.push(event as unknown as Started));
		const ui = {
			// The dialog queue is shared: this dialog must close with its signal so later tests are not queued behind it.
			select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
				new Promise<undefined>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined))),
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
		expect(events[0]).toMatchObject({ type: "ui_prompt_start", kind: "select", approval: true, blocking: true });
		controller.abort();
		await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "ui_prompt_end" }));
	});
});

describe("RPC dialogs a client did not answer", () => {
	it("tells the RPC host to close a dialog another client answered", async () => {
		const side = rpcSide((event) => side.events.push(event));
		const answered = side.ui.select("Run?", ["Allow once", "Deny"], { approval: true });
		const asked = request(side.output, "select")!;
		expect(asked).toMatchObject({ approval: true });
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
		const ui = {
			select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
				new Promise<string | undefined>((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
			confirm: async () => false,
			input: async () => undefined,
			notify: () => undefined,
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
	const ask = (relay: ChildRelay, extra: Record<string, unknown> = {}) =>
		relay.handle({
			type: "extension_ui_request",
			method: "select",
			id: "c1",
			title: "Run rm -rf build?",
			options: ["Allow once", "Deny"],
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
		expect(awaiting).toMatchObject({ kind: "approval", options: ["Allow once", "Deny"] });
		expect(awaiting.title).toContain("child-1");
		await vi.waitFor(() => expect(watch.state).toEqual({ busy: false, needsYou: awaiting.title }));
		expect(tracker.answer(awaiting.id!, { choice: "Allow once" })).toEqual({ ok: true });
		await vi.waitFor(() => expect(sent).toEqual([{ type: "extension_ui_response", id: "c1", value: "Allow once" }]));
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
