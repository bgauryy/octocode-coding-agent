import type { WorkspaceSnapshot } from "@octocodeai/octocode-contacts/workspace";
import { within } from "@testing-library/dom";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { renderBacklogHtml } from "../src/index.ts";

// These tests execute the generated page bundle exactly as the host serves it. React commits after the event that
// caused an update, so assertions that follow navigation, socket frames or clicks wait for the DOM to settle.
const pages: JSDOM[] = [];
afterEach(() => {
	for (const page of pages.splice(0)) page.window.close();
});
const STATES = ["backlog", "todo", "ongoing", "done"] as const;
const workspace: WorkspaceSnapshot = {
	sessionId: "session",
	agents: [
		{
			id: "worker",
			role: "reviewer",
			pid: 1,
			status: "working",
			joinedAt: 0,
			updatedAt: 0,
			toolCalls: 0,
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			unpriced: false,
		},
	],
	traffic: [],
	receipts: [],
	events: [
		{
			id: 1,
			at: 0,
			type: "message",
			text: "## Result\n\n```typescript\nconst answer = 42;\n```\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))",
		},
	],
};

/** Set a form control's value the way typing does, so React's change tracking sees it. */
function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const window = element.ownerDocument.defaultView!;
	const prototype =
		element instanceof window.HTMLTextAreaElement
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
	element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function page(fragment = "access=test") {
	let socket!: { onmessage?: (event: { data: string }) => void; onopen?: () => void };
	const fetch = vi.fn(async (_url?: string, _init?: RequestInit) => ({
		ok: true,
		json: async () => ({ receipt: { status: "accepted", message: "Queued" } }),
	}));
	const dom = new JSDOM(
		renderBacklogHtml({ repo: "test", generatedAt: 0, states: STATES, idleMs: 1000, items: [] }, true),
		{
			url: `http://localhost/#${fragment}`,
			runScripts: "dangerously",
			pretendToBeVisual: true,
			beforeParse(window) {
				Object.defineProperty(window, "WebSocket", {
					value: class {
						static OPEN = 1;
						readyState = 1;
						onmessage?: (event: { data: string }) => void;
						constructor() {
							socket = this;
						}
						send() {}
						close() {}
					},
				});
				Object.defineProperty(window, "fetch", { value: fetch });
				window.scrollTo = () => {};
			},
		},
	);
	pages.push(dom);
	const document = dom.window.document;
	const screen = within(document.body);
	await vi.waitFor(() => expect(socket).toBeDefined());
	const emit = (data: WorkspaceSnapshot) => socket.onmessage?.({ data: JSON.stringify({ type: "workspace", data }) });
	const navigate = (name: string) => {
		dom.window.history.replaceState(null, "", `#${name}`);
		dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
	};
	const button = (name: string) =>
		[...document.querySelectorAll("button")].find((element) => element.textContent === name);
	const findButton = (name: string) => vi.waitFor(() => button(name) ?? Promise.reject(new Error(`No button ${name}`)));
	emit(workspace);
	return {
		dom,
		document,
		screen,
		emit,
		navigate,
		button,
		findButton,
		fetch,
		application: (frame: unknown) => socket.onmessage?.({ data: JSON.stringify({ type: "application", data: frame }) }),
		backlogs: (data: unknown) => socket.onmessage?.({ data: JSON.stringify({ type: "snapshot", data }) }),
	};
}

it("keeps Markdown inspection controls and focused code in place when new events arrive", async () => {
	const app = await page();
	app.navigate("activity");
	const { document } = app;
	await vi.waitFor(() => expect(document.querySelector(".markdown-body h2")?.textContent).toBe("Result"));
	expect(document.querySelector(".markdown-body img, .markdown-body script, .markdown-body [onerror]")).toBeNull();
	expect(document.querySelector(".markdown-body a")?.hasAttribute("href")).toBe(false);
	expect(document.querySelector(".hljs-keyword")).not.toBeNull();
	(await app.findButton("Wrap code")).click();
	const wrap = await app.findButton("Wrap code");
	await vi.waitFor(() => expect(wrap.getAttribute("aria-pressed")).toBe("true"));
	wrap.focus();
	app.emit({ ...workspace, events: [...workspace.events, { id: 2, at: 1, type: "session", text: "Updated" }] });
	await vi.waitFor(() => expect(document.body.textContent).toContain("Updated"));
	expect(app.button("Wrap code")).toBe(wrap);
	expect(wrap.getAttribute("aria-pressed")).toBe("true");
	expect(document.activeElement).toBe(wrap);
	(await app.findButton("View source")).click();
	app.emit({ ...workspace, events: [...workspace.events, { id: 3, at: 2, type: "session", text: "Updated again" }] });
	await vi.waitFor(() => expect(document.body.textContent).toContain("Updated again"));
	expect(app.button("View Markdown")).toBeDefined();
});

it("restores message drafts across navigation and only clears them after acceptance", async () => {
	const app = await page();
	app.navigate("agents");
	const text = await app.screen.findByLabelText<HTMLTextAreaElement>("Message");
	type(text, "Please check the tests");
	app.navigate("activity");
	await app.findButton("Pause feed");
	app.navigate("agents");
	const restored = await app.screen.findByLabelText<HTMLTextAreaElement>("Message");
	expect(restored.value).toBe("Please check the tests");
	expect(app.screen.getByLabelText<HTMLSelectElement>("Recipient").required).toBe(true);
	app.fetch.mockImplementationOnce(async () => {
		app.emit({
			...workspace,
			receipts: [{ id: "accepted", action: "message", status: "accepted", at: 1, message: "Queued" }],
		});
		return { ok: true, json: async () => ({ receipt: { status: "accepted", message: "Queued" } }) };
	});
	restored.closest("form")!.requestSubmit();
	await vi.waitFor(() => expect(app.fetch).toHaveBeenCalledOnce());
	await vi.waitFor(() => expect(restored.value).toBe(""));
	expect(restored.isConnected).toBe(true);
	app.navigate("activity");
	await app.findButton("Pause feed");
	app.navigate("agents");
	await vi.waitFor(() => expect(app.screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe(""));
});

it("restores an unsaved item draft and lets the user explicitly discard it", async () => {
	const app = await page();
	(await app.findButton("New item")).click();
	const title = await app.screen.findByLabelText<HTMLInputElement>("Title");
	type(title, "Keep this task");
	app.navigate("agents");
	await vi.waitFor(() => expect(app.document.querySelector("#drawer")).toBeNull());
	(await app.findButton("New item")).click();
	await vi.waitFor(() => expect(app.screen.getByLabelText<HTMLInputElement>("Title").value).toBe("Keep this task"));
	(await app.findButton("Discard draft")).click();
	await vi.waitFor(() => expect(app.document.querySelector("#drawer")).toBeNull());
	(await app.findButton("New item")).click();
	await vi.waitFor(() => expect(app.screen.getByLabelText<HTMLInputElement>("Title").value).toBe(""));
});

it("renders an offline export without opening a socket or making a request", async () => {
	const network = vi.fn(() => {
		throw new Error("Offline export attempted network access");
	});
	const dom = new JSDOM(
		renderBacklogHtml({ repo: "offline-repo", generatedAt: 0, states: STATES, idleMs: 1000, items: [] }),
		{
			url: "file:///export.html",
			runScripts: "dangerously",
			beforeParse(window) {
				Object.defineProperty(window, "WebSocket", { value: network });
				Object.defineProperty(window, "fetch", { value: network });
			},
		},
	);
	pages.push(dom);
	await vi.waitFor(() => expect(dom.window.document.querySelector("h1")?.textContent).toBe("offline-repo"));
	expect(dom.window.document.querySelectorAll(".column")).toHaveLength(4);
	expect(network).not.toHaveBeenCalled();
});

it("renders assistant deltas before completion and exposes scoped session commands", async () => {
	const app = await page();
	app.navigate("activity");
	const { document } = app;
	const emit = (sequence: number, body: object) =>
		app.application({
			protocolVersion: 1,
			cursor: { sessionId: "session", epoch: "epoch-live", sequence },
			at: sequence,
			...body,
		});
	emit(0, {
		type: "snapshot",
		snapshot: {
			sessionId: "session",
			messages: [],
			streaming: true,
			runId: "run-live",
			steering: [],
			followUp: [],
			receipts: [],
			capabilities: ["prompt", "steer", "followUp", "abort"],
		},
	});
	emit(1, {
		type: "event",
		event: { type: "message.started", message: { id: "message-live", role: "assistant", text: "", complete: false } },
	});
	emit(2, { type: "event", event: { type: "message.delta", messageId: "message-live", delta: "## Partial answer" } });
	await vi.waitFor(() => expect(document.body.textContent).toContain("Partial answer"));
	expect(document.body.textContent).toContain("streaming");
	emit(3, {
		type: "event",
		event: {
			type: "message.completed",
			message: { id: "message-live", role: "assistant", text: "## Finished answer", complete: true },
		},
	});
	await vi.waitFor(() => expect(document.body.textContent).toContain("Finished answer"));
	expect(document.querySelectorAll(".markdown-body h2")).toHaveLength(2);
	expect(document.body.textContent).not.toContain("Partial answer");
	app.fetch.mockResolvedValueOnce({
		ok: true,
		json: async () => ({ receipt: { id: "stop-request", status: "accepted", message: "Stopping" } }),
	});
	(await app.findButton("Stop current run")).click();
	await vi.waitFor(() => expect(app.fetch).toHaveBeenCalledOnce());
	const body = JSON.parse(String(app.fetch.mock.calls[0][1]?.body));
	expect(body).toMatchObject({ action: "abort", sessionId: "session", runId: "run-live" });
	emit(4, {
		type: "event",
		event: { type: "command.receipt", receipt: { id: "stop-request", status: "completed", message: "Run stopped" } },
	});
	await vi.waitFor(() =>
		expect(document.querySelector('[aria-label="Recent session requests"]')?.textContent).toContain(
			"CompletedRun stopped",
		),
	);
	app.navigate("agents");
	await vi.waitFor(() => expect(document.querySelector('[aria-label="Recent session requests"]')).toBeNull());
	app.navigate("activity");
	await vi.waitFor(() =>
		expect(document.querySelector('[aria-label="Recent session requests"]')?.textContent).toContain(
			"CompletedRun stopped",
		),
	);
});

it("navigates every offline view and renders hostile item content as literal text", async () => {
	const title = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
	const item = {
		ref: "B1",
		title,
		goal: "",
		body: "",
		paths: [],
		why: "",
		evidence: [],
		plan: "",
		state: "backlog" as const,
		priority: "p2",
		tags: [],
		createdBy: "author",
		createdAt: 0,
		updatedAt: 0,
		version: 1,
		derived: [],
		notes: [],
	};
	const dom = new JSDOM(
		renderBacklogHtml({ repo: "offline", generatedAt: 0, states: STATES, idleMs: 1000, items: [item] }),
		{
			url: "file:///export.html",
			runScripts: "dangerously",
		},
	);
	pages.push(dom);
	const document = dom.window.document;
	for (const name of ["table", "tree", "attention", "board"]) {
		dom.window.location.hash = `#${name}`;
		dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
		await vi.waitFor(() =>
			expect(document.querySelector("nav a[aria-current=page]")?.getAttribute("href")).toContain(`#${name}`),
		);
		expect(document.querySelector("main")?.childElementCount).toBe(1);
	}
	dom.window.location.hash = "#B1";
	dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
	await vi.waitFor(() => expect(document.querySelector("#drawer")?.hasAttribute("hidden")).toBe(false));
	expect(document.querySelector("#item-title")?.textContent).toBe(title);
	expect(document.activeElement?.id).toBe("item-title");
	expect(document.querySelector("#drawer img, #drawer script")).toBeNull();
});

it.each([
	["activity", "activity"],
	["board", "board"],
	["unknown", "board"],
])("opens the requested SPA view %s and removes the access token", async (requested, expected) => {
	const app = await page(`access=test&view=${requested}`);
	expect(app.dom.window.location.hash).toBe(`#${expected}`);
	expect(app.dom.window.sessionStorage.getItem("backlog-access")).toBe("test");
	await vi.waitFor(() =>
		expect(app.document.querySelector("nav.tabs a.active")?.getAttribute("href")).toBe(`#${expected}`),
	);
	app.navigate(expected === "activity" ? "board" : "activity");
	expect(app.dom.window.location.hash).not.toContain("access");
});

it("opens the terminal view from the header and follows a run from thinking to a finished tool call", async () => {
	const app = await page();
	const { document } = app;
	const emit = (sequence: number, body: object) =>
		app.application({
			protocolVersion: 1,
			cursor: { sessionId: "session", epoch: "epoch-t", sequence },
			at: sequence * 1000,
			...body,
		});
	emit(0, {
		type: "snapshot",
		snapshot: {
			sessionId: "session",
			messages: [{ id: "u1", role: "user", text: "Run the tests", complete: true }],
			streaming: true,
			runId: "run-t",
			steering: [],
			followUp: [],
			receipts: [],
			capabilities: ["prompt", "steer", "followUp", "abort"],
		},
	});
	(await app.findButton("Terminal")).click();
	await vi.waitFor(() => expect(app.dom.window.location.hash).toBe("#activity?mode=terminal"));
	await vi.waitFor(() => expect(document.querySelector(".run-indicator")?.textContent).toContain("Thinking"));
	expect(app.screen.getByText("No commands yet")).toBeTruthy();
	// The host sends no text with tool.started; progress carries partial output and completion the final output.
	emit(1, { type: "event", event: { type: "tool.started", toolCallId: "t1", toolName: "bash" } });
	const transcript = await app.screen.findByRole("log", { name: "Terminal transcript" });
	await vi.waitFor(() => expect(transcript.textContent).toContain("bash"));
	expect(transcript.textContent).toContain("running");
	expect(document.querySelector(".run-indicator")?.textContent).toContain("Running bash");
	emit(2, {
		type: "event",
		event: { type: "tool.progress", toolCallId: "t1", toolName: "bash", text: "Running 3 tests" },
	});
	await vi.waitFor(() => expect(transcript.querySelector(".status-running")?.textContent).toContain("Running 3 tests"));
	emit(3, { type: "event", event: { type: "tool.completed", toolCallId: "t1", toolName: "bash", text: "3 passed" } });
	await vi.waitFor(() => expect(transcript.querySelector(".status-done")?.textContent).toContain("3 passed"));
	emit(4, {
		type: "event",
		event: { type: "message.started", message: { id: "a1", role: "assistant", text: "", complete: false } },
	});
	emit(5, { type: "event", event: { type: "message.delta", messageId: "a1", delta: "All tests pass." } });
	await vi.waitFor(() => expect(document.querySelector(".run-indicator")?.textContent).toContain("Writing response"));
	(await app.findButton("Feed")).click();
	// Thinking lasts until the first visible text (the delta at 5s), not until the empty message opened.
	await vi.waitFor(() => expect(document.body.textContent).toContain("Thought for 5s"));
	expect(app.dom.window.location.hash).toBe("#activity");
});

it("shows the board loading until the live page receives its first backlog snapshot", async () => {
	const app = await page("access=test&view=board");
	const { document } = app;
	await vi.waitFor(() => expect(document.querySelector('[aria-label="Loading board"]')).not.toBeNull());
	expect(document.getElementById("app")?.textContent).not.toContain("Your next idea starts here");
	app.backlogs({
		repo: "test",
		generatedAt: 0,
		states: ["backlog", "todo", "ongoing", "done"],
		idleMs: 1000,
		items: [],
	});
	await vi.waitFor(() => expect(document.querySelectorAll(".column")).toHaveLength(4));
	expect(document.querySelector('[aria-label="Loading board"]')).toBeNull();
});
