/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommandsView } from "../src/app/live/CommandsView.tsx";
import { TERMINAL_COMMAND_ROUTE, type TerminalCommandRequest } from "@octocodeai/octocode-contracts/protocol";

afterEach(() => vi.unstubAllGlobals());

it("finds a session command by alias and sends the selected command, arguments and dialog answer", async () => {
	const requests: TerminalCommandRequest[] = [];
	history.replaceState(null, "", "/?s=session#commands");
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		expect(url).toBe(`/s/session${TERMINAL_COMMAND_ROUTE}`);
		if (!init.body)
			return Response.json({
				sessionId: "session",
				commands: [{ name: "help" }, { name: "settings", aliases: ["config"] }],
			});
		const request: TerminalCommandRequest = JSON.parse(String(init.body));
		requests.push(request);
		if (request.action === "run")
			return Response.json({
				id: request.id,
				phase: "dialog",
				sequence: 0,
				dialog: "dialog",
				text: "Choose a setting",
			});
		return Response.json({ id: "closed", phase: "done", sequence: 1, text: "Saved" });
	});
	render(<CommandsView />);
	const search = await screen.findByRole("searchbox");
	fireEvent.change(search, { target: { value: "/config" } });
	fireEvent.change(screen.getByLabelText("Arguments for /config"), { target: { value: "list" } });
	fireEvent.click(screen.getByRole("button", { name: "Run /config" }));
	expect(await screen.findByText("Choose a setting")).toBeInTheDocument();
	expect(requests[0]).toMatchObject({ sessionId: "session", action: "run", name: "config", args: "list" });
	fireEvent.click(screen.getByRole("button", { name: "Enter" }));
	expect(await screen.findByText("Saved")).toBeInTheDocument();
	expect(requests[1]).toMatchObject({
		action: "input",
		sessionId: "session",
		dialog: "dialog",
		sequence: 1,
		key: "enter",
	});
});
