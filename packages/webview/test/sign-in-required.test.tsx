// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { live } from "../src/app/live/index.ts";
import { SIGN_IN_MESSAGE, requestJson } from "../src/request.ts";
import { FakeSocket } from "./helpers.ts";

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

it("reports a refused sign-in the same way whatever the body", async () => {
	for (const body of [JSON.stringify({ error: "Reopen /web" }), "<html>nope</html>"]) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 401 })),
		);
		await expect(requestJson("/api/config")).rejects.toThrow(SIGN_IN_MESSAGE);
	}
});

it("replaces the board skeleton with an error once the session refuses the link", async () => {
	if (!live?.Unavailable) throw new Error("live extension");
	const { Provider, Unavailable } = live;
	render(
		<Provider access="" backlog={createBacklogStore({ items: [], generatedAt: 0 } as never, false)}>
			<Unavailable hint="The board appears once the session connects." />
		</Provider>,
	);
	expect(screen.getByLabelText("Connecting to the session")).toBeInTheDocument();
	act(() => FakeSocket.instances[0]?.close(1008));
	expect(await screen.findByText("Can't reach the session")).toBeInTheDocument();
	expect(screen.getByText(/missing or has expired/)).toBeInTheDocument();
});
