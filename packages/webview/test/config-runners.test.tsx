/** @vitest-environment jsdom */
import type { RunnerCommand, RunnerList } from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnersPanel } from "../src/app/config/RunnersPanel.tsx";

afterEach(cleanup);

const list: RunnerList = {
	tasksEnabled: true,
	runners: [
		{
			id: "claude-code",
			name: "Claude Code",
			cli: { command: "claude", installed: true, version: "2.1.0", tested: "2.1.322", untested: true },
			adapter: { command: "claude-agent-acp", installed: false, install: "npm install -g claude-agent-acp" },
			signIn: { state: "signed-in", method: "claude.ai", billing: "plan" },
			login: "claude auth login",
			connected: true,
			enabled: true,
		},
		{
			id: "gemini",
			name: "Gemini CLI",
			cli: { command: "gemini", installed: false, tested: "0.1" },
			adapter: { command: "gemini", installed: false, install: "npm install -g @google/gemini-cli" },
			signIn: { state: "unchecked" },
			login: "gemini",
			connected: false,
			enabled: false,
		},
	],
};

const api = (act = vi.fn(async (_c: RunnerCommand) => list)) => ({ list: vi.fn(async () => list), act });

describe("RunnersPanel", () => {
	it("shows detection, install and sign-in facts per runner", async () => {
		render(<RunnersPanel api={api()} reloadKey="a" />);
		expect(await screen.findByText("Claude Code")).toBeTruthy();
		expect(screen.getByText(/checked from 2\.1\.322/)).toBeTruthy();
		expect(screen.getByText(/signed in/i)).toBeTruthy();
		expect(screen.getByText(/gemini not on PATH/)).toBeTruthy();
		expect(screen.getByText(/npm install -g @google\/gemini-cli/)).toBeTruthy();
	});

	it("sends check, disable and pause as one verb each", async () => {
		const act = vi.fn(async (_c: RunnerCommand) => list);
		render(<RunnersPanel api={api(act)} reloadKey="a" />);
		await screen.findByText("Claude Code");
		await userEvent.click(screen.getByRole("button", { name: "Check Claude Code" }));
		await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "check", id: "claude-code" }));
		await userEvent.click(screen.getByRole("button", { name: "Disable Claude Code for tasks" }));
		await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "set-enabled", id: "claude-code", enabled: false }));
		await userEvent.click(screen.getByRole("button", { name: "Pause all external agents" }));
		await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "set-tasks", enabled: false }));
	});

	it("does not offer enabling a runner that is not installed", async () => {
		render(<RunnersPanel api={api()} reloadKey="a" />);
		await screen.findByText("Gemini CLI");
		expect(screen.queryByRole("button", { name: /Enable Gemini CLI/ })).toBeNull();
	});

	it("explains where to manage runners without an api", () => {
		render(<RunnersPanel reloadKey="a" />);
		expect(screen.getByText(/Manage external agents through/)).toBeTruthy();
	});

	it("shows a load failure", async () => {
		render(<RunnersPanel api={{ list: async () => Promise.reject(new Error("boom")), act: vi.fn() }} reloadKey="a" />);
		expect((await screen.findByRole("alert")).textContent).toContain("boom");
	});
});
