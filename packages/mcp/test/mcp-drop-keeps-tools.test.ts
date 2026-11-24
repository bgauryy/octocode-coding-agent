import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconnect, setEnabled } from "../src/connections.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

const echo = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/echo-mcp.mjs");
const hosts: ReturnType<typeof mcpHost>[] = [];

/** The default servers with `reconnectWaitMs: 0`: a call made while one is down fails at once, which these tests observe. */
const failAtOnce: NonNullable<Parameters<typeof mcpHost>[0]>["loadConfig"] = (_ctx, defaults) => ({
	servers: defaults.map((entry) => ({ ...entry, config: { ...entry.config, reconnectWaitMs: 0 } })),
	errors: [],
});

/** Launches the echo server; with `relaunch` set, the next launches run that script instead (a server that hangs, say). */
function host(options: { relaunch?: { args: string[] } } = {}) {
	const launch = { down: false };
	const result = mcpHost({
		updateConfig: () => {},
		loadConfig: failAtOnce,
		prepareLaunch: (entry) => ({
			...entry,
			config: {
				...entry.config,
				command: process.execPath,
				args: launch.down && options.relaunch ? options.relaunch.args : [echo],
			},
		}),
	});
	hosts.push(result);
	return { h: result, launch };
}

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
});

/** What the provider receives of the server's tools: every declaration field, in registration order. */
const declared = (h: ReturnType<typeof mcpHost>) =>
	JSON.stringify([...h.tools.values()].filter((tool) => tool.name.startsWith("mcp__octocode__")));
const activeTools = (h: ReturnType<typeof mcpHost>) => JSON.stringify(h.api.tools.getActive());
/** Every batch of tool registrations the host received. */
const registrations = (h: ReturnType<typeof mcpHost>) => h.flat.registerToolBatches as string[][];
const connectionOf = (h: ReturnType<typeof mcpHost>) => h.state.findServer("octocode")!.connection!;

async function dropServer(h: ReturnType<typeof mcpHost>) {
	expect(await h.call("mcp__octocode__exit")).toMatchObject({ content: [{ text: "bye" }] });
	await vi.waitFor(() => expect(connectionOf(h).state).toBe("disconnected"));
}

describe("MCP tools across a dropped connection", () => {
	it("keeps the declarations byte-identical before a drop, during it and after the reconnect", async () => {
		const { h } = host();
		await h.start();
		await h.prompt();
		await h.call("mcp__octocode__grow");
		await vi.waitFor(() => expect(h.tools.get("mcp__octocode__late")?.exposure).toBe("direct"));
		const before = declared(h);
		const active = activeTools(h);
		const batches = registrations(h).length;
		expect(h.tools.get("mcp__octocode__shout").exposure).toBe("direct");

		await dropServer(h);
		expect(declared(h)).toBe(before);
		expect(activeTools(h)).toBe(active);
		const during = await h.prompt();
		expect(during.mcp_status).toContain("- octocode: disconnected");
		expect(during.mcps).toContain('<mcp name="octocode" tools="mcp__octocode__*">');

		expect(await reconnect(h.state.findServer("octocode")!)).toBeUndefined();
		expect(connectionOf(h).state).toBe("connected");
		// The reconnected server is a fresh process without the runtime tool, so only that tool changes.
		expect(h.tools.get("mcp__octocode__late")?.exposure).toBe("hidden");
		expect(h.tools.get("mcp__octocode__shout").exposure).toBe("direct");
		const after = JSON.parse(declared(h)) as Array<{ name: string }>;
		const original = JSON.parse(before) as Array<{ name: string }>;
		expect(after.map((tool) => tool.name)).toEqual(original.map((tool) => tool.name));
		expect(registrations(h).slice(batches).flat()).toEqual(["mcp__octocode__late"]);
	});

	it("keeps the declarations byte-identical when the reconnect offers the same catalog", async () => {
		const { h } = host();
		await h.start();
		await h.prompt();
		const before = declared(h);
		const batches = registrations(h).length;

		await dropServer(h);
		expect(await reconnect(h.state.findServer("octocode")!)).toBeUndefined();

		expect(declared(h)).toBe(before);
		expect(registrations(h)).toHaveLength(batches);
		expect(await h.call("mcp__octocode__shout", { text: "back" })).toMatchObject({ content: [{ text: "BACK" }] });
	});

	it("keeps the declarations through failed reconnects", async () => {
		const { h, launch } = host({ relaunch: { args: ["-e", "process.exit(1)"] } });
		await h.start();
		await h.prompt();
		const before = declared(h);
		const batches = registrations(h).length;

		launch.down = true;
		await dropServer(h);
		expect(await reconnect(h.state.findServer("octocode")!)).toBeDefined();
		expect(connectionOf(h).state).toBe("failed");
		expect(declared(h)).toBe(before);
		expect(registrations(h)).toHaveLength(batches);
		expect((await h.prompt()).mcp_status).toContain("- octocode: failed");
		await expect(h.call("mcp__octocode__shout", { text: "x" })).rejects.toThrow(
			/"octocode" is disconnected: it failed to connect.*restart it with the mcp tool/is,
		);

		// The server is back at the next restart, with the catalog it had.
		launch.down = false;
		expect(await reconnect(h.state.findServer("octocode")!)).toBeUndefined();
		expect(declared(h)).toBe(before);
		expect(registrations(h)).toHaveLength(batches);
	});

	it("fails a call made while the server is down at once, naming the state and the mcp tool, and reconnects for the next one", async () => {
		const { h } = host();
		await h.start();
		await h.prompt();
		await dropServer(h);

		await expect(h.call("mcp__octocode__shout", { text: "x" })).rejects.toThrow(
			/"octocode" is disconnected.*reconnecting.*mcp tool/s,
		);
		await vi.waitFor(() => expect(connectionOf(h).state).toBe("connected"));
		expect(await h.call("mcp__octocode__shout", { text: "x" })).toMatchObject({ content: [{ text: "X" }] });
	});

	it.skipIf(process.platform === "win32")(
		"drops a server that dies with a descendant holding its pipes, keeps its tools and reconnects for the next call",
		async () => {
			// The server's process leaves `sleep` holding its stderr, so its transport never sees `close` on its own.
			const holding = `require("node:child_process").spawn("sleep", ["30"], { stdio: ["ignore", "ignore", "inherit"] }); import(process.argv[1]);`;
			const result = mcpHost({
				updateConfig: () => {},
				loadConfig: failAtOnce,
				prepareLaunch: (entry) => ({
					...entry,
					config: { ...entry.config, command: process.execPath, args: ["-e", holding, echo] },
				}),
			});
			hosts.push(result);
			await result.start();
			await result.prompt();
			const before = declared(result);
			const batches = registrations(result).length;

			await dropServer(result);
			expect(declared(result)).toBe(before);
			expect(registrations(result)).toHaveLength(batches);

			await expect(result.call("mcp__octocode__shout", { text: "x" })).rejects.toThrow(
				/is disconnected.*reconnecting/s,
			);
			await vi.waitFor(() => expect(connectionOf(result).state).toBe("connected"));
			expect(await result.call("mcp__octocode__shout", { text: "x" })).toMatchObject({ content: [{ text: "X" }] });
		},
	);

	it("fails a call made during a reconnect that has not finished", async () => {
		const { h, launch } = host({ relaunch: { args: ["-e", "setInterval(()=>{},1000)"] } });
		await h.start();
		await h.prompt();
		launch.down = true;
		await dropServer(h);
		void reconnect(h.state.findServer("octocode")!);
		await vi.waitFor(() => expect(connectionOf(h).state).toBe("connecting"));

		await expect(h.call("mcp__octocode__shout", { text: "x" })).rejects.toThrow(
			/"octocode" is reconnecting.*mcp tool/s,
		);
	});

	it("withdraws the tools when the server is stopped", async () => {
		const { h } = host();
		await h.start();
		await h.prompt();
		await h.call("mcp", { intent: "stop", server: "octocode" });
		for (const tool of h.tools.values())
			if (tool.name.startsWith("mcp__octocode__")) expect(tool.exposure).toBe("hidden");
	});

	it("withdraws the tools when the server is disabled", async () => {
		const { h } = host();
		await h.start();
		await h.prompt();
		await dropServer(h);
		expect(await setEnabled(h.state, h.state.findServer("octocode")!, false)).toBeUndefined();
		for (const tool of h.tools.values())
			if (tool.name.startsWith("mcp__octocode__")) expect(tool.exposure).toBe("hidden");
	});
});
