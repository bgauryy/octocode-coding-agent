/** @vitest-environment jsdom */
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigSnapshot,
	type ToolExposureList,
	type ToolPinCommand,
} from "@octocodeai/octocode-contracts/config";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigView } from "../src/app/config/ConfigView.tsx";
import { ToolsPanel } from "../src/app/config/ToolsPanel.tsx";

afterEach(cleanup);

const snapshot = (writable: boolean): ConfigSnapshot => ({
	protocolVersion: CONFIG_PROTOCOL_VERSION,
	generatedAt: Date.UTC(2026, 10, 11),
	keychainAvailable: true,
	providers: [],
	settings: [],
	writable,
});

const list: ToolExposureList = {
	setting: "recent",
	live: true,
	groups: [
		{
			kind: "native",
			name: "native",
			pinnable: true,
			tools: [
				{ name: "web", state: "deferred", decidedBy: "recent" },
				{ name: "archive", pin: "deferred", state: "direct", decidedBy: "recent" },
				{ name: "bash", state: "direct", decidedBy: "core" },
			],
		},
		{
			kind: "mcp",
			name: "docs",
			pinnable: true,
			tools: [
				{ name: "search", state: "direct", decidedBy: "recent" },
				{ name: "drop", pin: "hidden", state: "hidden", decidedBy: "pin" },
			],
		},
		{
			kind: "mcp",
			name: "ext",
			pinnable: false,
			note: "Not in a configuration file a pin can be saved to.",
			tools: [{ name: "run", state: "direct", decidedBy: "default" }],
		},
	],
};

const toolsApi = (pin: (command: ToolPinCommand) => Promise<ToolExposureList>) => ({
	list: vi.fn(async () => list),
	pin: vi.fn(pin),
});
const rowOf = (table: string, name: string) =>
	within(screen.getByRole("table", { name: `${table} exposure` })).getByRole("row", {
		name: new RegExp(`^${name}\\b`),
	});

describe("ConfigView Tools panel", () => {
	it("shows a table for the native tools and one per server, with each tool's state and what decided it", async () => {
		render(<ConfigView load={async () => snapshot(true)} tools={toolsApi(async () => list)} />);
		const native = await screen.findByRole("table", { name: "Native tools exposure" });
		expect(within(native).getByRole("columnheader", { name: "This session" })).toBeInTheDocument();
		expect(rowOf("Native tools", "web")).toHaveTextContent("Deferred");
		expect(rowOf("Native tools", "web")).toHaveTextContent("Not used in the last 24 hours");
		// Pinned after the session started: the session's state, and the pin that waits.
		expect(rowOf("Native tools", "archive")).toHaveTextContent("Direct");
		expect(rowOf("Native tools", "archive")).toHaveTextContent("Deferred from the next session");
		expect(rowOf("Native tools", "bash")).toHaveTextContent("Always direct");
		expect(within(rowOf("Native tools", "bash")).queryByRole("combobox")).toBeNull();
		expect(rowOf("docs", "drop")).toHaveTextContent("Hidden");
		expect(rowOf("docs", "drop")).toHaveTextContent("Pinned");
		expect(within(rowOf("ext", "run")).queryByRole("combobox")).toBeNull();
		expect(screen.getByText("Not in a configuration file a pin can be saved to.")).toBeInTheDocument();
		expect(screen.getByText(/A pin applies from the\s+next session/)).toBeInTheDocument();
		expect(screen.getByText(/now recent/)).toBeInTheDocument();
	});

	it("offers hidden for an MCP tool only, sends one pin and shows the host's fresh list and message", async () => {
		const api = toolsApi(async (command) => ({
			...list,
			groups: list.groups.map((group) =>
				group.kind === "native"
					? { ...group, tools: group.tools.map((row) => (row.name === command.tool ? { ...row, pin: "direct" } : row)) }
					: group,
			),
			message: "Pinned web direct. It applies from the next session; running sessions keep what they declared.",
		}));
		render(<ConfigView load={async () => snapshot(true)} tools={api} />);
		const pin = await screen.findByRole("combobox", { name: "Pin web" });
		expect(within(pin).queryByRole("option", { name: "Hidden" })).toBeNull();
		expect(
			within(screen.getByRole("combobox", { name: "Pin search" })).getByRole("option", { name: "Hidden" }),
		).toBeInTheDocument();
		await userEvent.selectOptions(pin, "direct");
		expect(api.pin).toHaveBeenCalledWith({ kind: "native", tool: "web", pin: "direct", scope: "global" });
		expect(await screen.findByRole("status")).toHaveTextContent("Pinned web direct");
		expect(screen.getByRole("combobox", { name: "Pin web" })).toHaveValue("direct");
		expect(rowOf("Native tools", "web")).toHaveTextContent("Direct from the next session");
	});

	it("unpins with null, names the server of an MCP pin and shows a refusal beside the row", async () => {
		const api = toolsApi(async (command) => {
			if (command.kind === "native") throw new Error("The global settings file is invalid, so it was not changed.");
			return list;
		});
		render(<ConfigView load={async () => snapshot(true)} tools={api} />);
		await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Pin drop" }), "");
		expect(api.pin).toHaveBeenLastCalledWith({ kind: "mcp", server: "docs", tool: "drop", pin: null, scope: "global" });
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Pin archive" }), "direct");
		expect(await within(rowOf("Native tools", "archive")).findByRole("alert")).toHaveTextContent(
			"The global settings file is invalid",
		);
	});

	it("saves to the workspace only when a trusted workspace is chosen", async () => {
		const api = {
			list: vi.fn(async () => ({ ...list, workspace: { trusted: true } })),
			pin: vi.fn(async () => list),
		};
		render(<ToolsPanel api={api} repoId="session" reloadKey="1" />);
		await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Save pins to" }), "workspace");
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Pin search" }), "deferred");
		expect(api.list).toHaveBeenCalledWith("session");
		expect(api.pin).toHaveBeenCalledWith({
			kind: "mcp",
			server: "docs",
			tool: "search",
			pin: "deferred",
			scope: "workspace",
			repoId: "session",
		});
	});

	it("explains where to pin tools on a published link, and labels a list no session answered", async () => {
		const api = toolsApi(async () => list);
		const { unmount } = render(<ConfigView load={async () => snapshot(false)} tools={api} />);
		expect(await screen.findByText(/where you can see and pin\s+tools/)).toBeInTheDocument();
		expect(api.list).not.toHaveBeenCalled();
		unmount();
		const cold = { list: vi.fn(async () => ({ ...list, live: false })), pin: vi.fn(async () => list) };
		render(<ToolsPanel api={cold} reloadKey="1" />);
		const native = await screen.findByRole("table", { name: "Native tools exposure" });
		expect(within(native).getByRole("columnheader", { name: "Next session" })).toBeInTheDocument();
		expect(screen.getByText("Every other native tool is always direct.")).toBeInTheDocument();
	});
});
