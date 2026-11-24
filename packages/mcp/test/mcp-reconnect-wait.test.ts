import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconnect } from "../src/connections.ts";
import { validateMcpServerConfig } from "../src/servers.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
/** A server process that never answers `initialize`: its reconnect stays in progress. */
const HANGS = ["-e", "setInterval(()=>{},1000)"];
const hosts: ReturnType<typeof mcpHost>[] = [];

/** The echo server; once `launch.down` is set, the next launches run `relaunch` instead. `reconnectWaitMs` as configured. */
function host(options: { reconnectWaitMs?: number; relaunch?: string[] } = {}) {
	const launch = { down: false };
	const h = mcpHost({
		updateConfig: () => {},
		loadConfig: (_ctx, defaults) => ({
			servers: defaults.map((entry) => ({
				...entry,
				config: {
					...entry.config,
					...(options.reconnectWaitMs === undefined ? {} : { reconnectWaitMs: options.reconnectWaitMs }),
				},
			})),
			errors: [],
		}),
		prepareLaunch: (entry) => ({
			...entry,
			config: {
				...entry.config,
				command: process.execPath,
				args: launch.down && options.relaunch ? options.relaunch : [echo],
			},
		}),
	});
	hosts.push(h);
	return { h, launch };
}

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const connectionOf = (h: ReturnType<typeof mcpHost>) => h.state.findServer("octocode")!.connection!;

async function started(options: Parameters<typeof host>[0] = {}) {
	const made = host(options);
	await made.h.start();
	await made.h.prompt();
	return made;
}

async function dropServer(h: ReturnType<typeof mcpHost>) {
	expect(await h.call("mcp__octocode__exit")).toMatchObject({ content: [{ text: "bye" }] });
	await vi.waitFor(() => expect(connectionOf(h).state).toBe("disconnected"));
}

/** How long `run` took to reject, with the error it rejected with. */
async function rejection(run: () => Promise<unknown>): Promise<{ error: Error; ms: number }> {
	const from = performance.now();
	const error = await run().then(
		() => {
			throw new Error("the call succeeded");
		},
		(reason: Error) => reason,
	);
	return { error, ms: performance.now() - from };
}

describe("a tool call made while its MCP server reconnects", () => {
	it("waits for the reconnect a drop starts and succeeds, by default", async () => {
		const { h } = await started();
		await dropServer(h);

		expect(await h.call("mcp__octocode__shout", { text: "back" })).toMatchObject({ content: [{ text: "BACK" }] });
		expect(connectionOf(h).state).toBe("connected");
	});

	it("fails with the reconnecting message once the bound passes without a connection", async () => {
		const { h, launch } = await started({ reconnectWaitMs: 300, relaunch: HANGS });
		launch.down = true;
		await dropServer(h);

		const { error, ms } = await rejection(() => h.call("mcp__octocode__shout", { text: "x" }));
		expect(error.message).toMatch(/"octocode" is reconnecting; retry the call shortly.*mcp tool/s);
		expect(ms).toBeGreaterThanOrEqual(290);
		expect(ms).toBeLessThan(3_000);
		expect(connectionOf(h).state).toBe("connecting");
	});

	it("joins a reconnect already in progress", async () => {
		const { h } = await started();
		await dropServer(h);
		const reconnecting = connectionOf(h).getClient();
		expect(connectionOf(h).state).toBe("connecting");

		expect(await h.call("mcp__octocode__shout", { text: "x" })).toMatchObject({ content: [{ text: "X" }] });
		expect((await reconnecting).connectionState).toBe("connected");
		expect(h.transports).toHaveLength(2);
	});

	it("stops waiting when the call is aborted, and the reconnect goes on", async () => {
		const { h, launch } = await started({ reconnectWaitMs: 30_000, relaunch: HANGS });
		launch.down = true;
		await dropServer(h);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);

		const { error, ms } = await rejection(() => h.call("mcp__octocode__shout", { text: "x" }, controller.signal));
		expect(error.name).toBe("AbortError");
		expect(ms).toBeLessThan(3_000);
		expect(connectionOf(h).state).toBe("connecting");
	});

	it("fails at once with reconnectWaitMs 0, and still starts the reconnect", async () => {
		const { h } = await started({ reconnectWaitMs: 0 });
		await dropServer(h);

		await expect(h.call("mcp__octocode__shout", { text: "x" })).rejects.toThrow(
			/"octocode" is disconnected.*reconnecting.*mcp tool/s,
		);
		await vi.waitFor(() => expect(connectionOf(h).state).toBe("connected"));
	});

	it("does not wait for a server whose reconnect already failed", async () => {
		const { h, launch } = await started({ reconnectWaitMs: 30_000, relaunch: ["-e", "process.exit(1)"] });
		launch.down = true;
		await dropServer(h);
		expect(await reconnect(h.state.findServer("octocode")!)).toBeDefined();
		expect(connectionOf(h).state).toBe("failed");

		const { error, ms } = await rejection(() => h.call("mcp__octocode__shout", { text: "x" }));
		expect(error.message).toMatch(/"octocode" is disconnected: it failed to connect/);
		expect(ms).toBeLessThan(3_000);
	});

	it("fails after a reconnect that ends in failure during the wait, without waiting out the bound", async () => {
		const { h, launch } = await started({ reconnectWaitMs: 30_000, relaunch: ["-e", "process.exit(1)"] });
		launch.down = true;
		await dropServer(h);

		const { error, ms } = await rejection(() => h.call("mcp__octocode__shout", { text: "x" }));
		expect(error.message).toMatch(/"octocode" is disconnected: it failed to connect/);
		expect(ms).toBeLessThan(5_000);
	});
});

describe("reconnectWaitMs in a server entry", () => {
	const entry = (reconnectWaitMs: unknown) => validateMcpServerConfig("docs", { command: "docs", reconnectWaitMs });

	it("accepts 0 and positive numbers", () => {
		expect(entry(0)).toMatchObject({ reconnectWaitMs: 0 });
		expect(entry(2_500)).toMatchObject({ reconnectWaitMs: 2_500 });
	});

	it("rejects a negative number and a non-number", () => {
		expect(entry(-1)).toMatch(/reconnectWaitMs must be a number of milliseconds/);
		expect(entry("5s")).toMatch(/reconnectWaitMs must be a number of milliseconds/);
	});
});
