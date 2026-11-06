import type { ApplicationSnapshot, Member } from "@octocodeai/octocode-contracts";
import type { WorkspaceSnapshot } from "@octocodeai/octocode-contracts/workspace";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

export const fetchControl = vi.fn<typeof fetch>();
/** The JSON bodies the page sent; reads (the theme preference, no body) are not commands. */
export const posted = () =>
	fetchControl.mock.calls
		.filter(([, init]) => init?.body !== undefined)
		.map(([, init]) => JSON.parse(String(init?.body)));
export function receipt(init: RequestInit | undefined, status = "accepted", message = "Delivered") {
	const command = JSON.parse(String(init?.body));
	return new Response(
		JSON.stringify({
			receipt: { id: command.id, action: command.action, backlogId: command.backlogId, status, message, at: 0 },
		}),
	);
}
export function setupControls() {
	FakeSocket.instances = [];
	fetchControl.mockReset().mockImplementation(async (_url, init) => receipt(init));
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchControl);
}
export function deferredControl() {
	let resolve: (response: Response) => void;
	let options: RequestInit | undefined;
	fetchControl.mockImplementationOnce((_url, init) => {
		options = init;
		return new Promise((done) => {
			resolve = done;
		});
	});
	return (status = "accepted", message = "Delivered") => resolve(receipt(options, status, message));
}
export function member(overrides: Partial<Member> = {}): Member {
	return {
		id: "worker",
		role: "reviewer",
		status: "working",
		pid: 1,
		joinedAt: 0,
		updatedAt: 0,
		toolCalls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cost: 0,
		unpriced: false,
		...overrides,
	};
}
export function controlView(children: ReactNode) {
	const backlog = {
		repo: "test",
		generatedAt: 0,
		states: ["backlog", "todo", "ongoing", "done"] as const,
		idleMs: 1,
		items: [],
	};
	const store = createBacklogStore(backlog);
	const wrap = (content: ReactNode) => (
		<LiveProvider access="test" backlog={store}>
			{content}
		</LiveProvider>
	);
	const view = render(wrap(children));
	let sequence = 0;
	return {
		show: (content: ReactNode) => view.rerender(wrap(content)),
		workspace: async (overrides: Partial<WorkspaceSnapshot> = {}) => {
			act(() => {
				FakeSocket.instances[0].receive("workspace", {
					sessionId: "s",
					agents: [member()],
					traffic: [],
					events: [],
					receipts: [],
					...overrides,
				});
				FakeSocket.instances[0].receive("snapshot", backlog);
			});
			await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
		},
		session: async (overrides: Partial<ApplicationSnapshot> = {}) => {
			const sessionId = overrides.sessionId ?? "s";
			act(() =>
				FakeSocket.instances[0].receive("application", {
					protocolVersion: 1,
					cursor: { sessionId, epoch: `epoch-${sessionId}`, sequence: sequence++ },
					at: 0,
					type: "snapshot",
					snapshot: {
						sessionId,
						messages: [],
						streaming: false,
						steering: [],
						followUp: [],
						receipts: [],
						capabilities: ["prompt", "steer", "followUp", "abort"],
						...overrides,
					},
				}),
			);
			await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
		},
		disconnect: () => act(() => FakeSocket.instances[0].close(1008)),
	};
}
