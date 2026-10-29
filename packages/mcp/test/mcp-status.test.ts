import { describe, expect, it } from "vitest";
import { createEventBus, type EventBus } from "../../coding-agent/src/core/event-bus.ts";
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
