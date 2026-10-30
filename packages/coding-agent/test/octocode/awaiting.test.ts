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
		const long = awaitingFor({ kind: "input", title: `First line ${"x".repeat(400)}\nsecond line` });
		expect(long.kind).toBe("question");
		expect(long.title).toHaveLength(200);
		expect(long.title).not.toContain("second line");
	});

	it("publishes a blocking dialog while the run is active and clears it when the dialog closes", async () => {
		const { service, fake } = setup();
		const running = fakeCtx({ cwd: "/x", idle: false });
		await fake.emit("ui_prompt_start", { kind: "confirm", title: "Run bash?" }, running);
		expect(service.getSnapshot().awaiting).toEqual({ kind: "approval", title: "Run bash?" });
		await fake.emit("ui_prompt_end", { kind: "confirm", title: "Run bash?" }, running);
		expect(service.getSnapshot().awaiting).toBeUndefined();
	});

	it("keeps waiting while a stacked dialog is still open", async () => {
		const { service, fake } = setup();
		const running = fakeCtx({ cwd: "/x", idle: false });
		await fake.emit("ui_prompt_start", { kind: "select", title: "Pick a branch" }, running);
		await fake.emit("ui_prompt_start", { kind: "confirm", title: "Run bash?" }, running);
		await fake.emit("ui_prompt_end", { kind: "confirm", title: "Run bash?" }, running);
		expect(service.getSnapshot().awaiting).toEqual({ kind: "question", title: "Pick a branch" });
		await fake.emit("ui_prompt_end", { kind: "select", title: "Pick a branch" }, running);
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
		await fake.emit("ui_prompt_start", { kind: "select", title: "Permissions" }, idle);
		expect(service.getSnapshot().awaiting).toBeUndefined();
		await fake.emit("ui_prompt_end", { kind: "select", title: "Permissions" }, idle);
		expect(service.getSnapshot().awaiting).toBeUndefined();
	});
});
