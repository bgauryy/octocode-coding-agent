/** @vitest-environment jsdom */
import { CONFIG_PROTOCOL_VERSION, type McpAddResult } from "@octocodeai/octocode-contracts/config";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpPanel } from "../src/app/config/McpPanel.tsx";
import { ConfigView } from "../src/app/config/ConfigView.tsx";

afterEach(cleanup);
const result: McpAddResult = { saved: true, message: "Saved, not applied; review before enabling." };
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const available = async () => ({ available: true });
const open = async () => fireEvent.click(await screen.findByRole("button", { name: "Add MCP" }));
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save MCP" }));

describe("Add MCP form", () => {
	it("does not expose inputs while registry status is loading or unavailable", async () => {
		let resolve!: (value: { available: boolean; message: string }) => void;
		const status = () =>
			new Promise<{ available: boolean; message: string }>((done) => {
				resolve = done;
			});
		const add = vi.fn();
		render(<McpPanel add={add} status={status} trusted />);
		expect(screen.queryByRole("button", { name: "Add MCP" })).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
		resolve({ available: false, message: "Open a running session's Settings page." });
		await screen.findByText("Open a running session's Settings page.");
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(add).not.toHaveBeenCalled();
	});
	it("shows a fixed status error rather than secret inputs when availability lookup fails", async () => {
		render(
			<McpPanel
				add={vi.fn()}
				status={async () => {
					throw new Error("private-marker");
				}}
				trusted
			/>,
		);
		await screen.findByText(/Could not check the running session/);
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(document.body.textContent).not.toContain("private-marker");
	});
	it("shows audit warning alongside committed success and clears submitted credentials", async () => {
		const add = vi.fn().mockResolvedValue({ ...result, warnings: ["Audit recording unavailable"] });
		render(<McpPanel add={add} status={available} trusted />);
		await open();
		fill("Name", "local");
		fill("Command", "node");
		fill("Environment (JSON object)", '{"TOKEN":"private-marker"}');
		save();
		await screen.findByRole("status");
		expect((await screen.findByRole("alert")).textContent).toBe("Audit recording unavailable");
		expect(screen.queryByRole("form")).toBeNull();
		expect(document.body.textContent).not.toContain("private-marker");
	});
	it("discards draft and rechecks availability when switching session status readers", async () => {
		const add = vi.fn();
		const view = render(<McpPanel add={add} status={available} trusted />);
		await open();
		fill("Name", "old-draft");
		view.rerender(
			<McpPanel add={add} status={async () => ({ available: false, message: "Session disconnected" })} trusted />,
		);
		expect(screen.queryByRole("textbox")).toBeNull();
		await screen.findByText("Session disconnected");
		expect(add).not.toHaveBeenCalled();
	});
	it("saves literal stdio args and env without shell parsing, then clears the draft", async () => {
		const add = vi.fn().mockResolvedValue(result);
		render(<McpPanel status={available} add={add} trusted={false} />);
		await open();
		fill("Name", "local");
		fill("Command", "node");
		fill("Arguments (JSON array)", '["a b", "--port", "3"]');
		fill("Environment (JSON object)", '{"TOKEN":"private-marker"}');
		save();
		await screen.findByRole("status");
		expect(add).toHaveBeenCalledWith({
			name: "local",
			scope: "global",
			transport: "stdio",
			command: "node",
			args: ["a b", "--port", "3"],
			env: { TOKEN: "private-marker" },
		});
		expect(screen.queryByRole("form", { name: "Add MCP" })).toBeNull();
		expect(document.body.textContent).not.toContain("private-marker");
	});
	it("saves HTTP to the selected trusted workspace with headers", async () => {
		const add = vi.fn().mockResolvedValue(result);
		render(<McpPanel status={available} add={add} repoId="repo-a" trusted />);
		await open();
		fill("Name", "remote");
		fill("Save to", "workspace");
		fill("Transport", "http");
		fill("HTTP URL", "https://example.test/mcp");
		fill("Headers (JSON object)", '{"Authorization":"private-marker"}');
		save();
		await screen.findByRole("status");
		expect(add).toHaveBeenCalledWith({
			name: "remote",
			scope: "workspace",
			repoId: "repo-a",
			transport: "http",
			url: "https://example.test/mcp",
			headers: { Authorization: "private-marker" },
		});
	});
	it("retains invalid/failed drafts and cancels without another write", async () => {
		const add = vi.fn().mockRejectedValue(new Error("Already exists"));
		render(<McpPanel status={available} add={add} trusted={false} />);
		await open();
		save();
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(add).not.toHaveBeenCalled();
		fill("Name", "draft");
		fill("Command", "node");
		fill("Arguments (JSON array)", "invalid-private-marker");
		save();
		expect(screen.getByRole("alert").textContent).not.toContain("private-marker");
		expect(add).not.toHaveBeenCalled();
		fill("Arguments (JSON array)", "[]");
		save();
		await screen.findByText("Already exists");
		expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("draft");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(add).toHaveBeenCalledTimes(1);
		await open();
		expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("");
	});
	it("blocks invalid URL and disables workspace without trust", async () => {
		const add = vi.fn();
		render(<McpPanel status={available} add={add} repoId="repo" trusted={false} />);
		await open();
		expect(screen.getByRole<HTMLOptionElement>("option", { name: "Trusted workspace" }).disabled).toBe(true);
		fill("Name", "remote");
		fill("Transport", "http");
		fill("HTTP URL", "file:///private-marker");
		save();
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(add).not.toHaveBeenCalled();
	});
	it("read-only ConfigView never offers the write action", async () => {
		const addMcp = vi.fn();
		render(
			<ConfigView
				load={async () => ({
					protocolVersion: CONFIG_PROTOCOL_VERSION,
					generatedAt: 1,
					keychainAvailable: false,
					providers: [],
					settings: [],
					writable: false,
				})}
				addMcp={addMcp}
				mcpAddStatus={available}
			/>,
		);
		await screen.findByText(/Read-only. Open settings/);
		expect(screen.queryByRole("button", { name: "Add MCP" })).toBeNull();
		expect(addMcp).not.toHaveBeenCalled();
	});
	it("repository changes discard the old form before a different workspace can receive it", async () => {
		const addMcp = vi.fn();
		const load = vi.fn(async (id?: string) => ({
			protocolVersion: CONFIG_PROTOCOL_VERSION,
			generatedAt: 1,
			keychainAvailable: false,
			providers: [],
			settings: [],
			writable: true,
			...(id ? { workspace: { repo: id, trusted: true } } : {}),
		}));
		render(
			<ConfigView
				load={load}
				addMcp={addMcp}
				mcpAddStatus={available}
				repos={[
					{ id: "a", name: "A" },
					{ id: "b", name: "B" },
				]}
			/>,
		);
		await screen.findByRole("button", { name: "Add MCP" });
		await open();
		fill("Name", "old-draft");
		const selector = screen.getByRole("combobox", { name: /workspace/i });
		fireEvent.change(selector, { target: { value: "a" } });
		await waitFor(() => expect(load).toHaveBeenCalledWith("a"));
		await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
		expect(addMcp).not.toHaveBeenCalled();
	});
});
