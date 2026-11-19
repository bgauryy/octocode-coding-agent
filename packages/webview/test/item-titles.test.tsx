/** @vitest-environment jsdom */
import type { ReactNode } from "react";
import type { ApplicationMessage, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { ApplicationProjection } from "../src/app/live/application-projection.ts";
import { ResultCard } from "../src/app/live/ResultCard.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket, snapshotItem } from "./helpers.ts";

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

const board = createBacklogStore({
	repo: "r",
	generatedAt: 0,
	states: ["todo"],
	idleMs: 1,
	items: [snapshotItem("B12", { title: "Clickable backlog IDs" })],
});
function Wrapper({ children }: { children: ReactNode }) {
	return (
		<LiveProvider access="t" backlog={board}>
			{children}
		</LiveProvider>
	);
}
function show(role: "assistant" | "user", text: string): string {
	const message: ApplicationMessage = {
		id: "m",
		role,
		text,
		complete: true,
		content: [{ id: "b", type: "text", text }],
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
	return render(<ResultCard event={event} />, { wrapper: Wrapper }).container.textContent ?? "";
}

it("draws a known ID with its title at the first mention of an assistant reply", () => {
	const text = show("assistant", "Fixed B12 and then B12 again, B99 is unknown. `B12` stays.");
	expect(text).toContain("B12 “Clickable backlog IDs” and then B12 again");
	expect(text).toContain("B99 is unknown");
	expect(text).toContain("B12 stays");
	// The source view and Copy keep the stored text.
	expect(text.match(/Clickable backlog IDs/g)).toHaveLength(1);
	expect(text).toContain("Fixed B12 and then");
});

it("leaves a typed title and user text alone", () => {
	expect(show("assistant", "B12 (Clickable backlog IDs) done")).toContain("B12 (Clickable backlog IDs) done");
	expect(show("user", "see B12")).not.toContain("Clickable");
});
