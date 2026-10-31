import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { awaitingFor, registerAwaiting } from "../../src/octocode/ui/awaiting.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const services: Array<{ dispose(): void }> = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
});

function setup() {
	// `fakeCtx` answers every session lookup with the id "session-test".
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
	return { service, fake };
}

describe("awaiting", () => {
	it("maps a confirmation to an approval and other dialogs to a question, with a bounded one-line title", () => {
		expect(awaitingFor({ kind: "confirm", title: "Run bash?" })).toEqual({ kind: "approval", title: "Run bash?" });
		expect(awaitingFor({ kind: "select" })).toEqual({ kind: "question" });
		// A permission prompt is a select opened with the approval option.
		expect(awaitingFor({ kind: "select", title: "Run bash?", approval: true })).toEqual({
			kind: "approval",
			title: "Run bash?",
		});
		const long = awaitingFor({ kind: "input", title: `First line ${"x".repeat(400)}\nsecond line` });
		expect(long.kind).toBe("question");
		expect(long.title).toHaveLength(200);
		expect(long.title).not.toContain("second line");
	});

	it("publishes a blocking dialog while the run is active and clears it when the dialog closes", async () => {
		const { service, fake } = setup();
		const running = fakeCtx({ cwd: "/x", idle: false });
		await fake.emit("ui_prompt_start", { kind: "confirm", title: "Run bash?", id: "a" }, running);
		expect(service.getSnapshot().awaiting).toEqual({
			kind: "approval",
			title: "Run bash?",
			id: "a",
			options: [],
			allowsText: false,
		});
		await fake.emit("ui_prompt_end", { kind: "confirm", title: "Run bash?", id: "a" }, running);
		expect(service.getSnapshot().awaiting).toBeUndefined();
	});

	it("keeps waiting while a stacked dialog is still open", async () => {
		const { service, fake } = setup();
		const running = fakeCtx({ cwd: "/x", idle: false });
		await fake.emit("ui_prompt_start", { kind: "editor", title: "Pick a branch", id: "e" }, running);
		await fake.emit("ui_prompt_start", { kind: "editor", title: "Run bash?", id: "f", nested: true }, running);
		await fake.emit("ui_prompt_end", { kind: "editor", title: "Run bash?", id: "f", nested: true }, running);
		expect(service.getSnapshot().awaiting).toEqual({ kind: "question", title: "Pick a branch" });
		await fake.emit("ui_prompt_end", { kind: "editor", title: "Pick a branch", id: "e" }, running);
		expect(service.getSnapshot().awaiting).toBeUndefined();
	});

	it("carries the dialog id, options and text acceptance so a client can answer, and tracks nested dialogs", async () => {
		const { service, fake } = setup();
		const running = fakeCtx({ cwd: "/x", idle: false });
		await fake.emit(
			"ui_prompt_start",
			{ kind: "select", title: "Pick", id: "d1", options: ["Type my own", "A"], allowsText: false },
			running,
		);
		expect(service.getSnapshot().awaiting).toEqual({
			kind: "question",
			title: "Pick",
			id: "d1",
			options: ["Type my own", "A"],
			allowsText: false,
		});
		await fake.emit(
			"ui_prompt_start",
			{ kind: "input", title: "Your answer", id: "d2", allowsText: true, nested: true },
			running,
		);
		expect(service.getSnapshot().awaiting).toMatchObject({ id: "d2", allowsText: true });
		await fake.emit("ui_prompt_end", { kind: "input", id: "d2", nested: true }, running);
		expect(service.getSnapshot().awaiting).toMatchObject({ id: "d1" });
		await fake.emit("ui_prompt_end", { kind: "select", id: "d1" }, running);
		expect(service.getSnapshot().awaiting).toBeUndefined();
	});

	it("ignores dialogs the user opens while no run is active", async () => {
		const { service, fake } = setup();
		const idle = fakeCtx({ cwd: "/x", idle: true });
		await fake.emit("ui_prompt_start", { kind: "select", title: "Permissions", id: "p" }, idle);
		expect(service.getSnapshot().awaiting).toBeUndefined();
		await fake.emit("ui_prompt_end", { kind: "select", title: "Permissions", id: "p" }, idle);
		expect(service.getSnapshot().awaiting).toBeUndefined();
	});

	it("removes the dialog that closed, whatever order dialogs close in", async () => {
		const { service, fake } = setup();
		const running = fakeCtx({ cwd: "/x", idle: false });
		await fake.emit("ui_prompt_start", { kind: "select", title: "First", id: "d1", options: ["a"] }, running);
		await fake.emit("ui_prompt_start", { kind: "select", title: "Second", id: "d2", options: ["b"] }, running);
		await fake.emit("ui_prompt_end", { kind: "select", id: "d1" }, running);
		expect(service.getSnapshot().awaiting).toMatchObject({ id: "d2", title: "Second" });
		await fake.emit("ui_prompt_end", { kind: "select", id: "unknown" }, running);
		expect(service.getSnapshot().awaiting).toMatchObject({ id: "d2" });
		await fake.emit("ui_prompt_end", { kind: "select", id: "d2" }, running);
		expect(service.getSnapshot().awaiting).toBeUndefined();
	});

	it("does not let the close of a dialog skipped while idle remove another dialog's entry", async () => {
		const { service, fake } = setup();
		const idle = fakeCtx({ cwd: "/x", idle: true });
		const running = fakeCtx({ cwd: "/x", idle: false });
		await fake.emit("ui_prompt_start", { kind: "select", title: "Picker", id: "skipped" }, idle);
		await fake.emit("ui_prompt_start", { kind: "select", title: "Approve", id: "live", options: ["Yes"] }, running);
		await fake.emit("ui_prompt_end", { kind: "select", id: "skipped" }, running);
		expect(service.getSnapshot().awaiting).toMatchObject({ id: "live" });
	});

	it("clears the published dialog when the session shuts down", async () => {
		const { service, fake } = setup();
		const running = fakeCtx({ cwd: "/x", idle: false });
		await fake.emit("ui_prompt_start", { kind: "select", title: "Pick", id: "d1", options: ["a"] }, running);
		expect(service.getSnapshot().awaiting).toMatchObject({ id: "d1" });
		await fake.emit("session_shutdown", { reason: "new" }, running);
		expect(service.getSnapshot().awaiting).toBeUndefined();
	});

	it("reports a blocking dialog while idle and after the run settles, but not an ordinary one", async () => {
		const { service, fake } = setup();
		const idle = fakeCtx({ cwd: "/x", idle: true });
		const running = fakeCtx({ cwd: "/x", idle: false });
		await fake.emit(
			"ui_prompt_start",
			{ kind: "select", title: "Child asks", id: "b", options: ["Yes"], blocking: true },
			idle,
		);
		expect(service.getSnapshot().awaiting).toMatchObject({ id: "b", title: "Child asks" });
		await fake.emit("ui_prompt_start", { kind: "select", title: "Pick", id: "o", options: ["x"] }, running);
		await fake.emit("agent_settled", { aborted: false }, idle);
		expect(service.getSnapshot().awaiting).toMatchObject({ id: "b" });
		await fake.emit("ui_prompt_end", { kind: "select", id: "b" }, idle);
		expect(service.getSnapshot().awaiting).toBeUndefined();
		await fake.emit("ui_prompt_start", { kind: "select", title: "Pick", id: "o2", options: ["x"] }, running);
		await fake.emit("agent_settled", { aborted: false }, idle);
		expect(service.getSnapshot().awaiting).toBeUndefined();
	});
});
