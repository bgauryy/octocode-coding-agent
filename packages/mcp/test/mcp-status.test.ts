import { describe, expect, it } from "vitest";
import { createEventBus, type EventBus } from "@octocodeai/octocode-agent-core";
import { formatStatus } from "../src/report.ts";
import type { McpServer } from "../src/server.ts";
import type { McpExtensionState } from "../src/state.ts";
import { getMcpSessionStatus, setMcpSessionStatus, type McpServerStatus } from "../src/status.ts";

const server = (name: string): McpServerStatus => ({
	name,
	enabled: true,
	state: "connected",
	exposure: "hidden",
	toolCount: 2,
	source: "test",
});
const wrapper = (bus: EventBus): EventBus => ({
	emit: (channel, value) => bus.emit(channel, value),
	on: (channel, handler) => bus.on(channel, handler),
});

describe("shared MCP status", () => {
	it("publishes the whole host registry through distinct wrappers of the same session bus", () => {
		const bus = createEventBus();
		const configured = wrapper(bus),
			reader = wrapper(bus);
		setMcpSessionStatus(configured, [server("docs"), { ...server("octocode"), enabled: false, state: "disabled" }]);
		expect(getMcpSessionStatus(reader).map(({ name, enabled }) => ({ name, enabled }))).toEqual([
			{ name: "docs", enabled: true },
			{ name: "octocode", enabled: false },
		]);
		setMcpSessionStatus(configured, []);
		expect(getMcpSessionStatus(reader)).toEqual([]);
		expect(getMcpSessionStatus(createEventBus())).toEqual([]);
	});

	it("copies published and returned values so readers cannot change another owner's status", () => {
		const bus = createEventBus();
		const original = server("docs");
		setMcpSessionStatus(bus, [original]);
		original.enabled = false;
		getMcpSessionStatus(bus)[0].state = "failed";
		expect(getMcpSessionStatus(bus)).toEqual([server("docs")]);
	});
});

describe("formatStatus", () => {
	const entry = (name: string, enabled = true) => ({
		name,
		config: { command: "unused", ...(enabled ? {} : { enabled: false }) },
		source: "test",
	});
	const status = (servers: Partial<McpServer>[]) =>
		formatStatus({ servers, configErrors: [], overridden: [] } as unknown as McpExtensionState);

	it("names each server's state, so an unselected server does not read as starting", () => {
		const connection = (state: string, more = {}) => ({ state, tools: [{ name: "a" }], ...more }) as never;
		const lines = status([
			{ entry: entry("browser"), unselected: true },
			{ entry: entry("pending") },
			{ entry: entry("off", false) },
			{ entry: entry("live"), connection: connection("connected") },
			{ entry: entry("dropped"), connection: connection("disconnected") },
			{ entry: entry("ended"), connection: connection("connected", { isStopped: true }) },
			{ entry: entry("broken"), connection: connection("failed", { error: "first\nsecond" }) },
		]).split("\n");
		expect(lines).toEqual([
			"browser: enabled · not selected · 0 tools · direct · every agent · Global · test",
			"pending: enabled · starting · 0 tools · direct · every agent · Global · test",
			"off: disabled · 0 tools · direct · every agent · Global · test",
			"live: enabled · connected · 1 tool · direct · every agent · Global · test",
			"dropped: enabled · disconnected, reconnects on next call · 0 tools · direct · every agent · Global · test",
			"ended: enabled · stopped · 1 tool · direct · every agent · Global · test",
			"broken: enabled · failed · 0 tools · direct · every agent · Global · test",
			"    first",
			"    second",
		]);
	});
});
