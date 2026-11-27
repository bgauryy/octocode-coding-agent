/** @vitest-environment jsdom */
import type { Endpoint, ProfileMessage, ProfileTimeline } from "@octocodeai/octocode-contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createElement, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageDetail } from "../src/app/live/profiler/ItemDetail.tsx";
import { MessagesPanel } from "../src/app/live/profiler/MessagesPanel.tsx";
import type { PanelProps } from "../src/app/live/profiler/panel-props.ts";
import { ProfilerFeed } from "../src/app/live/profiler-api.ts";
import { ProfilerView } from "../src/app/live/ProfilerView.tsx";
import { indexBacklog } from "../src/app/model/backlog.ts";
import { createWorkspaceStore } from "../src/state.ts";
import { agent } from "./profiler-fixtures.ts";

const live: Record<string, unknown> = vi.hoisted(() => ({}));
vi.mock("../src/app/live/session.tsx", () => ({ useLive: () => live }));

afterEach(cleanup);

const T0 = 1_000_000;
const main: Endpoint = { id: "main", role: "main", worktree: "main", branch: "wave2" };
const tidal: Endpoint = { id: "tidal", role: "reviewer", worktree: "worktree fix-a", branch: "fix-a", tmuxPane: "%12" };
const gone: Endpoint = { id: "shy", role: "tester", departed: true };

const routed: ProfileMessage = {
	id: 1,
	from: "main",
	to: ["tidal", "shy"],
	at: T0,
	state: "delivered",
	preview: "review this",
	text: "review this\nand the tests too",
	fromEndpoint: main,
	toEndpoints: [tidal, gone],
	deliveries: [
		{ recipient: "tidal", state: "answered" },
		{ recipient: "shy", state: "dead-lettered", read: false },
	],
	transcript: { agentId: "main", sessionId: "s-one", entry: 7 },
};
const notice: ProfileMessage = {
	id: -5,
	from: "team",
	to: ["tidal"],
	at: T0 + 5,
	state: "delivered",
	preview: "check in",
	internal: true,
	label: "octocode-team-notice",
};

function props(messages: ProfileMessage[], overrides: Partial<PanelProps> = {}): PanelProps {
	const timeline: ProfileTimeline = { sessionId: "s", events: [], messages, until: T0, hasMore: false };
	return {
		agents: [],
		requests: new Map(),
		timeline,
		selection: undefined,
		onSelect: () => undefined,
		range: undefined,
		onRange: () => undefined,
		filter: "",
		...overrides,
	};
}

it("shows sender(role) \u2192 recipient(role) with worktree, branch and tmux marks, delivery states and departed", () => {
	render(createElement(MessagesPanel, props([routed])));
	const row = screen.getAllByRole("row")[1];
	const cell = row?.querySelector(".pf-m-route");
	expect(cell?.textContent).toContain("main");
	expect(cell?.textContent).toContain("tidal (reviewer)");
	expect(cell?.textContent).toContain("shy (tester)");
	const marks = within(cell as HTMLElement);
	expect(marks.getByText("worktree fix-a")).toBeTruthy();
	expect(marks.getByText("fix-a")).toBeTruthy();
	expect(marks.getByText("tmux %12")).toBeTruthy();
	expect(marks.getByText("wave2")).toBeTruthy();
	expect(marks.getByText("departed")).toBeTruthy();
	// Several recipients: each one's own delivery state.
	expect(marks.getByText("answered")).toBeTruthy();
	expect(marks.getByText("dead-lettered")).toBeTruthy();
	expect(row?.getAttribute("aria-label")).toContain("main \u2192 tidal (reviewer), shy (tester)");
});

it("falls back to the bare ids and shows no per-recipient state for one recipient", () => {
	render(
		createElement(
			MessagesPanel,
			props([
				{
					id: 2,
					from: "a",
					to: ["b"],
					at: T0,
					state: "queued",
					preview: "x",
					deliveries: [{ recipient: "b", state: "queued" }],
				},
			]),
		),
	);
	expect(screen.getAllByRole("row")[1]?.querySelector(".pf-m-route")?.textContent).toBe("a \u2192 b");
});

it("hides internal notices until the list is switched, then shows them with their label", async () => {
	const user = userEvent.setup();
	render(createElement(MessagesPanel, props([routed, notice])));
	expect(screen.getAllByRole("row")).toHaveLength(2);
	expect(screen.queryByText("octocode-team-notice")).toBeNull();

	await user.click(screen.getByRole("button", { name: "All" }));
	expect(screen.getAllByRole("row")).toHaveLength(3);
	expect(screen.getByText("octocode-team-notice")).toBeTruthy();

	await user.click(screen.getByRole("button", { name: "Internal" }));
	expect(screen.getAllByRole("row")).toHaveLength(2);
	expect(screen.getByText("octocode-team-notice")).toBeTruthy();
	expect(screen.queryByText("review this")).toBeNull();
});

it("loads the sender's transcript on select: full text, short thinking inline, long thinking behind a toggle", async () => {
	const user = userEvent.setup();
	const long = "considering the options ".repeat(40);
	const profilerTranscript = vi.fn(async (agentId: string, entry: number) => ({
		agentId,
		entry,
		entries: [
			{ entry: 6, role: "user" as const, at: T0 - 5, text: "please ask tidal" },
			{ entry: 7, role: "assistant" as const, at: T0, thinking: long, text: "sending it", tools: ["send"] },
			{ entry: 8, role: "toolResult" as const, at: T0 + 1, thinking: "short thought" },
		],
	}));
	live.api = { profilerTranscript };
	render(createElement(MessageDetail, { message: routed }));

	expect(screen.getByText(/and the tests too/)).toBeTruthy();
	await waitFor(() => expect(screen.getByText("sending it")).toBeTruthy());
	expect(profilerTranscript).toHaveBeenCalledWith("main", 7, "s-one", expect.anything());
	expect(screen.getByText("short thought")).toBeTruthy();
	expect(screen.queryByText(long.trim())).toBeNull();

	const toggle = screen.getByRole("button", { name: /Show thinking \(960 characters\)/ });
	await user.click(toggle);
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	expect(screen.getByText(long.trim())).toBeTruthy();
});

it("says when the transcript read fails", async () => {
	live.api = {
		profilerTranscript: vi.fn(async () => {
			throw new Error("Could not load the transcript");
		}),
	};
	render(createElement(MessageDetail, { message: routed }));
	expect((await screen.findByRole("alert")).textContent).toContain("Could not load the transcript");
});

function Harness() {
	const [params, setParams] = useState<Record<string, string>>({ panel: "messages" });
	return (
		<ProfilerView
			index={indexBacklog({ repo: "r", generatedAt: 0, states: [], idleMs: 1, items: [] })}
			params={params}
			setParams={setParams}
		/>
	);
}

it("pages past the live list by cursor: each click sends the last cursor and appends, never refetching", async () => {
	const user = userEvent.setup();
	const ancient: ProfileMessage = {
		id: 0,
		from: "main",
		to: ["tidal"],
		at: T0 - 900_000,
		state: "answered",
		preview: "ancient",
	};
	const older: ProfileMessage = {
		id: 3,
		from: "main",
		to: ["tidal"],
		at: T0 - 600_000,
		state: "answered",
		preview: "older one",
	};
	const cursor = { at: older.at, key: "m:000000000003" };
	const profilerMessages = vi.fn(async (_limit: number, before?: { at: number; key: string }) =>
		before?.key === cursor.key ? { messages: [ancient] } : { messages: [older], next: cursor },
	);
	live.profiler = new ProfilerFeed();
	live.workspace = createWorkspaceStore();
	live.api = {
		profilerAgents: vi.fn(async () => ({ sessionId: "s", agents: [agent("main")], generatedAt: T0 })),
		profilerRequests: vi.fn(async (id: string) => ({ agentId: id, requests: [], hasMore: false })),
		profilerTimeline: vi.fn(async () => ({
			sessionId: "s",
			events: [],
			messages: [routed],
			until: T0,
			hasMore: false,
		})),
		profilerInsights: vi.fn(async () => ({ sessionId: "s", findings: [], generatedAt: T0 })),
		profilerMessages,
	};
	render(<Harness />);

	await screen.findByText("review this");
	await user.click(screen.getByRole("button", { name: "Load older messages" }));
	await screen.findByText("older one");
	// The first page starts below the live list's oldest message.
	expect(profilerMessages).toHaveBeenNthCalledWith(1, 30, { at: T0, key: "m:000000000001" });
	expect(screen.getByRole("button", { name: "Load older messages" })).toBeTruthy();

	await user.click(screen.getByRole("button", { name: "Load older messages" }));
	await screen.findByText("ancient");
	expect(profilerMessages).toHaveBeenNthCalledWith(2, 30, cursor);
	// Nothing was fetched twice: the live row and the first page are still listed once.
	expect(screen.getAllByText("older one")).toHaveLength(1);
	await waitFor(() => expect(screen.getByText("No older messages.")).toBeTruthy());
	expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
});
