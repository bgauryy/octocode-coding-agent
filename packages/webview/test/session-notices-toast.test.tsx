/** @vitest-environment jsdom */
import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { SessionNotices } from "../src/app/live/SessionNotices.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

const snapshot: ApplicationSnapshot = {
	sessionId: "s",
	messages: [],
	tools: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: [],
	activities: [
		{ id: "old", kind: "notice", at: 1, text: "From before the page", source: "live", data: { level: "info" } },
	],
};
const frame = (sequence: number, body: object) => ({
	protocolVersion: 1,
	cursor: { sessionId: "s", epoch: "e", sequence },
	at: sequence,
	...body,
});
beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200 })),
	);
});
afterEach(() => vi.unstubAllGlobals());

it("toasts a notice the session sends while the page is open, and none it already held", async () => {
	render(
		<LiveProvider
			access="token"
			backlog={createBacklogStore({ repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] })}
		>
			<SessionNotices />
		</LiveProvider>,
	);
	act(() => FakeSocket.instances[0].receive("application", frame(0, { type: "snapshot", snapshot })));
	await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
	expect(screen.queryByRole("status")).toBeNull();
	const activity = {
		id: "n1",
		kind: "notice",
		at: 2,
		text: "Hook configuration diagnostics: bad matcher",
		source: "live",
		data: { level: "error" },
		outcome: "failed",
	};
	act(() =>
		FakeSocket.instances[0].receive(
			"application",
			frame(1, { type: "event", event: { type: "session.activity", activity } }),
		),
	);
	await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
	expect(screen.getByRole("alert")).toHaveTextContent("Hook configuration diagnostics: bad matcher");
	expect(screen.queryByText("From before the page")).toBeNull();
});
