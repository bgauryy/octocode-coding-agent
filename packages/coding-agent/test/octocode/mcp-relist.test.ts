import "../mcp-host.ts";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { connectionFixture } from "../../../mcp/test/mcp-connection-fixture.ts";

describe("MCP tool refresh ordering", () => {
	it.each(["overlap", "connecting"])("keeps the newest tools when notifications arrive during %s", async (mode) => {
		const seen: string[][] = [];
		const failures: string[] = [];
		const server = connectionFixture({
			launch: (cwd) => ({
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/relist-mcp.mjs", import.meta.url)), mode],
				cwd,
				env: {},
			}),
			onTools: (connection) => seen.push(connection.tools.map((tool) => tool.name)),
			onChange: (connection) => {
				if (connection.state === "failed") failures.push(connection.error ?? "failed");
			},
			timeoutMs: 5_000,
		});
		try {
			expect(
				await server.getClient().then(
					() => true,
					() => false,
				),
			).toBe(true);
			// Both reversed responses must have reached the client before inspecting its final published list.
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(failures).toEqual([]);
			expect(seen).toEqual([["initial"], ["new"]]);
		} finally {
			await server.close();
		}
	});

	it("reports a failed re-list once, and withdraws unverified tools", async () => {
		const seen: string[][] = [];

		const statuses: Array<{ state: string; tools: number }> = [];
		const server = connectionFixture({
			launch: (cwd) => ({
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/relist-mcp.mjs", import.meta.url)), "failing"],
				cwd,
				env: {},
			}),
			onTools: (connection) => seen.push(connection.tools.map((tool) => tool.name)),
			onChange: (connection) => statuses.push({ state: connection.state, tools: connection.tools.length }),
			timeoutMs: 5_000,
		});
		try {
			expect(
				await server.getClient().then(
					() => true,
					() => false,
				),
			).toBe(true);
			// The fixture announces a change twice; both re-lists fail.
			await vi.waitFor(() => expect(server.error).toContain("list failed"));
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(server.error).toContain("list failed");
			expect(seen).toEqual([["initial"], []]);
			expect(server.tools.length).toBe(0);
			expect(server.instructions).toBeUndefined();
			expect(statuses.at(-1)).toMatchObject({ state: "connected", tools: 0 });
		} finally {
			await server.close();
		}
	});
});

describe("client errors on a live connection", () => {
	it("keeps the latest client error in the status instead of dropping it", async () => {
		const statuses: Array<{ state: string; tools: number }> = [];
		const server = connectionFixture({
			launch: (cwd) => ({
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/malformed-mcp.mjs", import.meta.url))],
				cwd,
				env: {},
			}),
			onTools: () => undefined,
			onChange: (connection) => statuses.push({ state: connection.state, tools: connection.tools.length }),
			timeoutMs: 5_000,
		});
		try {
			expect(
				await server.getClient().then(
					() => true,
					() => false,
				),
			).toBe(true);
			await vi.waitFor(() => expect(server.clientError).toMatch(/invalid JSON-RPC message/i));
			// A client error on a live connection is not a connection failure.
			expect(server.state).toBe("connected");
			expect(server.clientError).toMatch(/invalid JSON-RPC message/i);
		} finally {
			await server.close();
		}
	});
});
