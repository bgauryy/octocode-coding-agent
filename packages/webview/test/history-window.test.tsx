/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import type { ApplicationMessage, ApplicationSnapshot, ApplicationTool } from "@octocodeai/octocode-contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { HistoryPanel } from "../src/app/live/HistoryPanel.tsx";
import { retainEvicted } from "../src/app/live/history-window.ts";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

/** The stream keeps the newest 200 messages; history pages must stay contiguous with that sliding window. */
const LIVE_WINDOW = 200;
const message = (id: string, order: number): ApplicationMessage => ({
	id,
	role: "assistant",
	text: "",
	complete: true,
	order,
	content: [{ id: `${id}-text`, type: "text", text: `Text of ${id}` }],
});
const live = (from: number, to: number) =>
	Array.from({ length: to - from }, (_, index) => message(`m${from + index}`, 100 + from + index));
const snapshot: ApplicationSnapshot = {
	sessionId: "s",
	messages: live(0, LIVE_WINDOW),
	tools: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: [],
};
const requests: string[] = [];
let replies: Array<unknown> = [];
let sequence = 0;

beforeEach(() => {
	requests.length = 0;
	replies = [];
	sequence = 0;
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			requests.push(String(url));
			const reply = replies.shift();
			const body = typeof reply === "function" ? await reply() : reply;
			return new Response(JSON.stringify(body), { status: 200 });
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<LiveProvider
			access="token"
			backlog={createBacklogStore({ repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] })}
		>
			{children}
		</LiveProvider>
	);
}
function receive(body: object) {
	act(() =>
		FakeSocket.instances[0].receive("application", {
			protocolVersion: 1,
			cursor: { sessionId: "s", epoch: "e", sequence },
			at: ++sequence,
			...body,
		}),
	);
}
function stream(from: number, to: number) {
	for (const next of live(from, to)) receive({ type: "event", event: { type: "message.started", message: next } });
}
const page = (ids: string[], hasMore = false, firstOrder = 0) => ({
	messages: ids.map((id, index) => message(id, firstOrder + index)),
	tools: [],
	...(ids.length ? { before: ids[0] } : {}),
	hasMore,
});
const earlier = () => within(screen.getByRole("region", { name: "Earlier conversation" }));

async function loadEarlier() {
	await userEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
}

it("moves messages that leave the live window into the loaded history instead of dropping them", async () => {
	replies = [page(["h0", "h1"])];
	render(<HistoryPanel />, { wrapper: Wrapper });
	receive({ type: "snapshot", snapshot });
	await loadEarlier();
	await earlier().findByText("Text of h1");
	expect(requests[0]).toBe("/api/application/history?sessionId=s&limit=50&before=m0");

	stream(LIVE_WINDOW, LIVE_WINDOW + 2);

	await waitFor(() => expect(earlier().getByText("Text of m1")).toBeInTheDocument());
	expect(earlier().getByText("Text of m0")).toBeInTheDocument();
	expect(earlier().queryByText("Text of m2")).toBeNull();
	expect(
		earlier()
			.getAllByText(/^Text of /)
			.map((node) => node.textContent),
	).toEqual(["Text of h0", "Text of h1", "Text of m0", "Text of m1"]);
	expect(earlier().getByText("4 earlier messages")).toBeInTheDocument();
	expect(earlier().getByText("Beginning of conversation")).toBeInTheDocument();
});

it("keeps messages evicted while the first page is in flight", async () => {
	let finish: (value: unknown) => void = () => {};
	replies = [() => new Promise((resolve) => (finish = resolve))];
	render(<HistoryPanel />, { wrapper: Wrapper });
	receive({ type: "snapshot", snapshot });
	await loadEarlier();
	await waitFor(() => expect(requests).toHaveLength(1));

	stream(LIVE_WINDOW, LIVE_WINDOW + 1);
	await act(async () => finish(page(["h0"])));

	await earlier().findByText("Text of h0");
	expect(
		earlier()
			.getAllByText(/^Text of /)
			.map((node) => node.textContent),
	).toEqual(["Text of h0", "Text of m0"]);
});

it("bounds retained history to the requested depth and keeps the older part loadable", async () => {
	replies = [page(["h0", "h1"], true)];
	render(<HistoryPanel />, { wrapper: Wrapper });
	receive({ type: "snapshot", snapshot });
	await loadEarlier();
	await earlier().findByText("Text of h1");

	// One page asks for 50 messages, so 60 evictions keep the newest 50 and drop the oldest 12.
	stream(LIVE_WINDOW, LIVE_WINDOW + 60);

	await waitFor(() => expect(earlier().getByText("50 earlier messages")).toBeInTheDocument());
	const shown = earlier()
		.getAllByText(/^Text of /)
		.map((node) => node.textContent);
	expect(shown).toHaveLength(50);
	expect(shown[0]).toBe("Text of m10");
	expect(shown.at(-1)).toBe("Text of m59");
	expect(earlier().queryByText("Beginning of conversation")).toBeNull();

	replies = [page(["m8", "m9"], true, 108)];
	await loadEarlier();
	await earlier().findByText("Text of m9");
	expect(requests[1]).toBe("/api/application/history?sessionId=s&limit=50&before=m10");
	expect(earlier().getByText("52 earlier messages")).toBeInTheDocument();
});

it("moves evicted tools that belong before the live window and leaves tools inside it", () => {
	const tool = (toolCallId: string, order: number, extra: Partial<ApplicationTool> = {}): ApplicationTool => ({
		toolCallId,
		toolName: "read",
		text: "",
		status: "completed",
		order,
		...extra,
	});
	const linked = tool("linked", 30, { messageId: "a" });
	const older = tool("older", 9);
	const inside = tool("inside", 14);
	const retained = tool("retained", 13);
	const result = retainEvicted(
		{ messages: [], tools: [], before: "a", hasMore: true, limit: 50 },
		{ messages: [message("a", 10), message("b", 12)], tools: [older, linked, inside, retained] },
		{ messages: [message("b", 12)], tools: [retained] },
	);
	expect(result.messages.map((item) => item.id)).toEqual(["a"]);
	expect(result.tools.map((item) => item.toolCallId)).toEqual(["older", "linked"]);
	expect(result.before).toBe("a");
});
