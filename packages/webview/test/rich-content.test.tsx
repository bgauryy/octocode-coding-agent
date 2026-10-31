/** @vitest-environment jsdom */
import { Blob as NodeBlob } from "node:buffer";
import type { ReactNode } from "react";
import type {
	ApplicationAsset,
	ApplicationContentBlock,
	ApplicationMessage,
	ApplicationSnapshot,
	ApplicationTool,
} from "@octocodeai/octocode-contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { ApplicationProjection, type FeedEvent } from "../src/app/live/application-projection.ts";
import { HistoryPanel } from "../src/app/live/HistoryPanel.tsx";
import { groupFeed, terminalEntries } from "../src/app/live/model.ts";
import { ResultCard } from "../src/app/live/ResultCard.tsx";
import { SessionComposer } from "../src/app/live/SessionComposer.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

const asset: ApplicationAsset = { id: "image-a", mimeType: "image/png", size: 1, name: "diagram.png" };
const snapshot: ApplicationSnapshot = {
	sessionId: "s",
	messages: [],
	tools: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: ["prompt"],
};
const message = (content: ApplicationContentBlock[], extra: Partial<ApplicationMessage> = {}): ApplicationMessage => ({
	id: "m",
	role: "assistant",
	text: "",
	complete: true,
	content,
	...extra,
});
const requests: Array<{ url: string; init: RequestInit }> = [];
const revoke = vi.fn();
let replies: Array<unknown> = [];
let urlSequence = 0;
const NativeURL = URL;

beforeEach(() => {
	requests.length = 0;
	replies = [];
	urlSequence = 0;
	revoke.mockClear();
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("Blob", NodeBlob);
	vi.stubGlobal(
		"URL",
		class extends NativeURL {
			static createObjectURL() {
				return `blob:attachment-${++urlSequence}`;
			}
			static revokeObjectURL(value: string) {
				revoke(value);
			}
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			requests.push({ url: String(url), init });
			const reply = replies.shift() ?? { asset, encoding: "base64", data: "eA==" };
			const body = typeof reply === "function" ? await reply(init) : reply;
			if (body instanceof Error) throw body;
			return new Response(JSON.stringify(body), { status: 200 });
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<LiveProvider
			access="secret-token"
			backlog={createBacklogStore({ repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] })}
		>
			{children}
		</LiveProvider>
	);
}
function project(messages: ApplicationMessage[], tools: ApplicationTool[] = []): FeedEvent[] {
	return new ApplicationProjection().update({ ...snapshot, messages, tools }, 10);
}
function announce(value: ApplicationSnapshot = snapshot) {
	act(() =>
		FakeSocket.instances[0].receive("application", {
			protocolVersion: 1,
			cursor: { sessionId: value.sessionId, epoch: `epoch-${value.sessionId}`, sequence: 0 },
			at: 10,
			type: "snapshot",
			snapshot: value,
		}),
	);
}

it("renders an image-only user message from authenticated bytes and releases its object URL", async () => {
	const [event] = project([message([{ id: "i", type: "image", asset }], { role: "user" })]);
	const view = render(<ResultCard event={event} />, { wrapper: Wrapper });
	expect(screen.getByRole("heading", { name: "You" })).toBeInTheDocument();
	const image = await screen.findByRole("img", { name: "diagram.png" });
	expect(image).toHaveAttribute("src", "blob:attachment-1");
	expect(requests[0]).toMatchObject({
		url: "/api/application/assets/image-a?sessionId=s",
		init: { headers: { Authorization: "Bearer secret-token" } },
	});
	expect(screen.getByRole("link", { name: "Download diagram.png" })).toHaveAttribute("download", "diagram.png");
	view.unmount();
	expect(revoke).toHaveBeenCalledWith("blob:attachment-1");
});

it("keeps text, tool output, and following text in block order with one visible tool", () => {
	const tool: ApplicationTool = {
		toolCallId: "t",
		toolName: "inspect",
		text: "output",
		status: "completed",
		arguments: { path: "actual.ts", reason: "Inspect the\nactual file" },
		structuredContent: { records: [7] },
		content: [{ id: "out", type: "text", text: "Tool result" }],
	};
	const events = project(
		[
			message([
				{ id: "a", type: "text", text: "Before tool" },
				{ id: "call", type: "toolCall", toolCallId: "t", name: "inspect", arguments: { path: "old.ts" } },
				{ id: "b", type: "text", text: "After tool" },
			]),
		],
		[tool],
	);
	expect(groupFeed(events)).toHaveLength(1);
	expect(groupFeed(events, true)).toHaveLength(2);
	expect(terminalEntries(events)).toHaveLength(1);
	const { container } = render(<ResultCard event={events[0]} />, { wrapper: Wrapper });
	const text = container.textContent;
	expect(text.indexOf("Before tool")).toBeLessThan(text.indexOf("Tool result"));
	expect(text.indexOf("Tool result")).toBeLessThan(text.indexOf("After tool"));
	expect(text).toContain("actual.ts");
	expect(text).not.toContain("old.ts");
	expect(within(screen.getByRole("region", { name: "Tool inspect" })).getByText(/"records"/)).toHaveTextContent("7");
	// The call's reason, on one line under the tool's name.
	expect(container.querySelector(".content-tool > .tool-reason")?.textContent).toBe("↳ Inspect the actual file");
});

it("renders reasoning, citations, resource references and unsupported content without external media requests", () => {
	const [event] = project([
		message([
			{ id: "r", type: "thinking", text: "Reasoning summary" },
			{
				id: "t",
				type: "text",
				text: "Answer",
				annotations: [
					{ type: "url_citation", title: "Source", url: "https://example.com/source" },
					{ type: "url_citation", title: "Unsafe", url: "javascript:alert(1)" },
				],
			},
			{ id: "m", type: "media", mimeType: "video/mp4", uri: "https://example.com/video", name: "Video" },
			{ id: "d", type: "resource", uri: "file:///private/secret", name: "Reference", text: "Resource text" },
			{ id: "u", type: "unsupported", providerType: "future_output", text: "Future output preserved" },
		]),
	]);
	render(<ResultCard event={event} />, { wrapper: Wrapper });
	expect(screen.getByText("Reasoning summary")).toBeInTheDocument();
	expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute("href", "https://example.com/source");
	expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
	expect(screen.getByRole("link", { name: "Video" })).toHaveAttribute("href", "https://example.com/video");
	expect(screen.queryByRole("link", { name: "Reference" })).toBeNull();
	expect(screen.getByText("Future output preserved")).toBeInTheDocument();
	expect(requests).toEqual([]);
});

it("shows failed empty assistant messages with their provider error", () => {
	const [event] = project([
		message([], {
			status: "failed",
			stopReason: "error",
			errorMessage: "Provider rejected request",
			model: "model-a",
			provider: "vendor-a",
		}),
	]);
	render(<ResultCard event={event} />, { wrapper: Wrapper });
	expect(screen.getByRole("alert")).toHaveTextContent("Provider rejected request");
	expect(screen.getByText("Needs attention")).toBeInTheDocument();
	expect(screen.getByText("vendor-a / model-a")).toBeInTheDocument();
});

it("loads the complete text asset when a preview was shortened", async () => {
	const full = { id: "text-a", mimeType: "text/plain", size: 20 };
	replies = [{ asset: full, encoding: "utf8", data: "Complete original content" }];
	const [event] = project([message([{ id: "t", type: "text", text: "Short preview", full }])]);
	render(<ResultCard event={event} />, { wrapper: Wrapper });
	await userEvent.click(screen.getByRole("button", { name: "Load full content" }));
	await screen.findByText("Complete original content");
	expect(screen.queryByText("Short preview")).toBeNull();
});

it("uploads an image and submits its session asset id without requiring text", async () => {
	replies = [
		{ asset },
		(init: RequestInit) => ({ receipt: { id: JSON.parse(String(init.body)).id, status: "accepted" } }),
	];
	render(<SessionComposer />, { wrapper: Wrapper });
	announce();
	const input = await screen.findByLabelText("Attach images");
	await userEvent.upload(input, new File(["x"], "diagram.png", { type: "image/png" }));
	await screen.findByRole("button", { name: "Remove diagram.png" });
	await userEvent.click(screen.getByRole("button", { name: "Send" }));
	await waitFor(() => expect(requests).toHaveLength(2));
	expect(JSON.parse(String(requests[0].init.body))).toEqual({
		sessionId: "s",
		mimeType: "image/png",
		name: "diagram.png",
		data: "eA==",
	});
	expect(JSON.parse(String(requests[1].init.body))).toMatchObject({
		sessionId: "s",
		action: "prompt",
		text: "",
		attachments: ["image-a"],
	});
	await waitFor(() => expect(screen.queryByRole("button", { name: "Remove diagram.png" })).toBeNull());
});

it("loads older messages separately without replacing the live session", async () => {
	replies = [
		{
			messages: [message([{ id: "old-t", type: "text", text: "Older answer" }], { id: "old" })],
			tools: [],
			hasMore: false,
		},
	];
	render(<HistoryPanel />, { wrapper: Wrapper });
	announce({
		...snapshot,
		messages: [message([{ id: "now-t", type: "text", text: "Current answer" }], { id: "current" })],
	});
	await userEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
	await screen.findByText("Older answer");
	expect(requests[0].url).toBe("/api/application/history?sessionId=s&limit=50&before=current");
	expect(screen.getByText("Beginning of conversation")).toBeInTheDocument();
});

it("preserves text edited while an image upload is in flight", async () => {
	let finish: (value: unknown) => void = () => {};
	replies = [
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	];
	render(<SessionComposer />, { wrapper: Wrapper });
	announce();
	await userEvent.upload(
		await screen.findByLabelText("Attach images"),
		new File(["x"], "diagram.png", { type: "image/png" }),
	);
	await waitFor(() => expect(requests).toHaveLength(1));
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Keep this latest draft");
	await act(async () => finish({ asset }));
	await screen.findByRole("button", { name: "Remove diagram.png" });
	expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this latest draft");
});

it("does not attach an upload from a previous session to the new composer", async () => {
	let finish: (value: unknown) => void = () => {};
	replies = [
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	];
	render(<SessionComposer />, { wrapper: Wrapper });
	announce();
	await userEvent.upload(
		await screen.findByLabelText("Attach images"),
		new File(["x"], "diagram.png", { type: "image/png" }),
	);
	await waitFor(() => expect(requests).toHaveLength(1));
	announce({ ...snapshot, sessionId: "next" });
	await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "New session draft");
	await act(async () => {
		finish({ asset });
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(screen.queryByRole("button", { name: "Remove diagram.png" })).toBeNull();
	expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("New session draft");
	expect(requests).toHaveLength(1);
});

it("refreshes revised assets and releases the superseded object URL", async () => {
	const first = { ...asset, revision: "one" };
	const second = { ...asset, revision: "two" };
	replies = [
		{ asset: first, encoding: "base64", data: "eA==" },
		{ asset: second, encoding: "base64", data: "eQ==" },
	];
	const event = (value: ApplicationAsset) => project([message([{ id: "i", type: "image", asset: value }])])[0];
	const view = render(<ResultCard event={event(first)} />, { wrapper: Wrapper });
	expect(await screen.findByRole("img", { name: "diagram.png" })).toHaveAttribute("src", "blob:attachment-1");
	view.rerender(<ResultCard event={event(second)} />);
	await waitFor(() =>
		expect(screen.getByRole("img", { name: "diagram.png" })).toHaveAttribute("src", "blob:attachment-2"),
	);
	expect(revoke).toHaveBeenCalledWith("blob:attachment-1");
	expect(requests).toHaveLength(2);
});

it("shows an asset read failure instead of an empty image message", async () => {
	replies = [new Error("Attachment is no longer available")];
	const [event] = project([message([{ id: "i", type: "image", asset }])]);
	render(<ResultCard event={event} />, { wrapper: Wrapper });
	expect(await screen.findByRole("alert")).toHaveTextContent("Attachment is no longer available");
	expect(screen.queryByRole("img")).toBeNull();
});

it("clears loaded historical pages when the session changes branches", async () => {
	replies = [
		{
			messages: [message([{ id: "old-t", type: "text", text: "Old branch history" }], { id: "old" })],
			tools: [],
			hasMore: false,
		},
	];
	render(<HistoryPanel />, { wrapper: Wrapper });
	announce();
	await userEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
	await screen.findByText("Old branch history");
	act(() =>
		FakeSocket.instances[0].receive("application", {
			protocolVersion: 1,
			cursor: { sessionId: "s", epoch: "epoch-s", sequence: 1 },
			at: 11,
			type: "event",
			event: { type: "session.reset", messages: [], tools: [] },
		}),
	);
	expect(screen.queryByText("Old branch history")).toBeNull();
	expect(screen.getByRole("button", { name: "Load earlier messages" })).toBeInTheDocument();
});

it("shows an unavailable-content notice while the following message remains readable", () => {
	const events = new ApplicationProjection().update(
		{
			...snapshot,
			errors: [
				{ type: "application.error", id: "e", code: "content-unavailable", message: "Attachment limit reached" },
			],
			messages: [message([{ id: "text", type: "text", text: "The next answer is intact" }])],
		},
		1,
	);
	render(
		<>
			{events.map((event) => (
				<ResultCard key={event.id} event={event} />
			))}
		</>,
		{ wrapper: Wrapper },
	);
	expect(screen.getByRole("alert")).toHaveTextContent("Attachment limit reached");
	expect(screen.getByText("The next answer is intact")).toBeInTheDocument();
});
