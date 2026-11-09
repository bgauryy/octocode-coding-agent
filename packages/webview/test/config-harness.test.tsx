/** @vitest-environment jsdom */
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigSnapshot,
	type HarnessList,
	type HarnessSwitchCommand,
} from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigView } from "../src/app/config/ConfigView.tsx";
import { HarnessPanel } from "../src/app/config/HarnessPanel.tsx";

afterEach(cleanup);

const snapshot = (writable: boolean): ConfigSnapshot => ({
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: Date.UTC(2026, 10, 9),
	keychainAvailable: true,
	providers: [],
	settings: [],
	writable,
});

const list: HarnessList = {
	rows: [
		{
			id: "harness:octocode",
			kind: "harness",
			label: "Octocode",
			on: true,
			setBy: "default",
			locked: "Always on",
			appliesWhen: "reload",
		},
		{
			id: "harness:claude",
			kind: "harness",
			label: "Claude Code",
			detail: "default off · found 2 skills",
			on: false,
			setBy: "default",
			appliesWhen: "reload",
		},
		{
			id: "mcp:docs",
			kind: "mcp",
			label: "docs",
			detail: "Global · ~/.claude.json",
			on: true,
			setBy: "default",
			appliesWhen: "now",
		},
		{
			id: "skill:/u/.claude/skills/demo/SKILL.md",
			kind: "skill",
			label: "demo",
			on: true,
			setBy: "default",
			appliesWhen: "reload",
		},
	],
};

function harnessApi(set: (command: HarnessSwitchCommand) => Promise<HarnessList>) {
	return { list: vi.fn(async () => list), set: vi.fn(set) };
}

describe("ConfigView Harness panel", () => {
	it("groups the /harness switches and offers no switch for an always-on row", async () => {
		const api = harnessApi(async () => list);
		render(<ConfigView load={async () => snapshot(true)} harness={api} />);
		const harnesses = await screen.findByRole("list", { name: "Harnesses" });
		expect(within(harnesses).getByText("Claude Code")).toBeInTheDocument();
		expect(within(harnesses).getByText("default off · found 2 skills")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Turn off Octocode" })).toBeNull();
		expect(within(screen.getByRole("list", { name: "MCP servers" })).getByText("docs")).toBeInTheDocument();
		expect(within(screen.getByRole("list", { name: "Skills" })).getByText("demo")).toBeInTheDocument();
		expect(api.list).toHaveBeenCalledWith(undefined);
	});

	it("sends one switch and shows the host's fresh list and message", async () => {
		const api = harnessApi(async (command) => ({
			rows: list.rows.map((row) => (row.id === command.id ? { ...row, on: command.on, setBy: "global" } : row)),
			message: "Harness claude enabled. Run /reload to apply.",
		}));
		render(<ConfigView load={async () => snapshot(true)} harness={api} />);
		await userEvent.click(await screen.findByRole("button", { name: "Turn on Claude Code" }));
		expect(api.set).toHaveBeenCalledWith({ id: "harness:claude", on: true, scope: "global" });
		expect(await screen.findByRole("button", { name: "Turn off Claude Code" })).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("Harness claude enabled. Run /reload to apply.");
	});

	it("shows the host's refusal beside the row and filters by name", async () => {
		const api = harnessApi(async () => {
			throw new Error("The global settings file is invalid, so it was not changed.");
		});
		render(<ConfigView load={async () => snapshot(true)} harness={api} />);
		await userEvent.click(await screen.findByRole("button", { name: "Turn off docs" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The global settings file is invalid");
		await userEvent.type(screen.getByRole("textbox", { name: "Filter switches" }), "claude code");
		expect(screen.queryByRole("list", { name: "MCP servers" })).toBeNull();
		expect(screen.getByRole("list", { name: "Harnesses" })).toBeInTheDocument();
	});

	it("does not show one workspace's rows while another workspace's rows load", async () => {
		const api = {
			list: vi.fn((repoId?: string) =>
				repoId === "b"
					? new Promise<HarnessList>(() => {})
					: Promise.resolve({ ...list, workspace: { trusted: true } }),
			),
			set: vi.fn(async () => list),
		};
		const { rerender } = render(<HarnessPanel api={api} repoId="a" reloadKey="1" />);
		expect(await screen.findByText("Claude Code")).toBeInTheDocument();
		rerender(<HarnessPanel api={api} repoId="b" reloadKey="1" />);
		expect(screen.queryByText("Claude Code")).toBeNull();
		expect(api.list).toHaveBeenLastCalledWith("b");
	});

	it("never asks a published link for the rows and says where to change them", async () => {
		const api = harnessApi(async () => list);
		render(<ConfigView load={async () => snapshot(false)} harness={api} />);
		expect(await screen.findByText(/Open this page from the Octocode terminal/)).toBeInTheDocument();
		expect(api.list).not.toHaveBeenCalled();
	});
});
