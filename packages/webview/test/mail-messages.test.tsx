/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import type { ApplicationMessage, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { ApplicationProjection } from "@octocodeai/octocode-projections";
import { ResultCard } from "../src/app/live/ResultCard.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<LiveProvider
			access="t"
			backlog={createBacklogStore({ repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] })}
		>
			{children}
		</LiveProvider>
	);
}
function show(extra: Partial<ApplicationMessage>) {
	const message: ApplicationMessage = {
		id: "m",
		role: "custom",
		customType: "octocode-agent-message",
		display: true,
		text: "notice for the model",
		complete: true,
		content: [{ id: "b", type: "text", text: "notice for the model" }],
		...extra,
	};
	const snapshot: ApplicationSnapshot = {
		sessionId: "s",
		messages: [message],
		tools: [],
		streaming: false,
		steering: [],
		followUp: [],
		receipts: [],
		capabilities: [],
	};
	const [event] = new ApplicationProjection().update(snapshot, 10);
	return render(<ResultCard event={event} />, { wrapper: Wrapper }).container;
}

it("draws delivered mail as a header and a body, not the model's notice", () => {
	const view = show({
		details: {
			messages: [
				{
					from: "ink",
					to: "main",
					id: 51,
					at: 0,
					replyRequired: true,
					sender: { role: "researcher" },
					text: "Which branch?",
				},
			],
		},
	});
	const header = view.querySelector(".mail-header")?.textContent ?? "";
	expect(header).toMatch(/^✉ 🐙 ink → main · #51 · request · \d\d:\d\d:\d\d$/);
	expect(view.querySelector(".mail-body")?.textContent).toContain("Which branch?");
	expect(view.textContent).not.toContain("notice for the model");
});

it("folds a long body and falls back to the model's text without a batch", () => {
	const long = show({ details: { messages: [{ from: "ink", id: 1, text: "a\nb\nc\nd\ne" }] } });
	expect(long.querySelector("details summary")?.textContent).toContain("2 more lines");
	expect(long.querySelector(".mail-header")?.textContent).toContain("FYI");
	expect(show({ details: { other: 1 } }).textContent).toContain("notice for the model");
});
