import { Text } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InkHost, mountInk } from "../src/host.tsx";
import { fakeTerminal } from "./fake-terminal.ts";

const hosts: InkHost[] = [];
afterEach(() => {
	for (const host of hosts.splice(0)) host.unmount();
});

describe("mountInk", () => {
	it("writes every frame through the terminal, wrapped in synchronized output, never touching stdin", async () => {
		const terminal = fakeTerminal();
		const listeners = () => process.stdin.listenerCount("readable") + process.stdin.listenerCount("data");
		const before = listeners();
		const host = mountInk(<Text>hello</Text>, { terminal, screen: "inline" });
		hosts.push(host);
		await vi.waitFor(() => expect(terminal.output.join("")).toContain("hello"));
		const output = terminal.output.join("");
		expect(output).toContain("\x1b[?2026h");
		expect(output).toContain("\x1b[?2026l");
		expect(output.indexOf("\x1b[?2026h")).toBeLessThan(output.indexOf("hello"));
		expect(host.counters.writes).toBe(terminal.output.length);
		expect(listeners()).toBe(before);
	});

	it("enters the alternate screen with mouse reports in fullscreen and leaves both on unmount", async () => {
		const terminal = fakeTerminal();
		const host = mountInk(<Text>full</Text>, { terminal, screen: "fullscreen" });
		await vi.waitFor(() => expect(terminal.output.join("")).toContain("full"));
		const started = terminal.output.join("");
		expect(started).toContain("\x1b[?1049h");
		expect(started).toContain("\x1b[?1006h");
		expect(started).toContain("\x1b[?25l");
		host.unmount();
		const ended = terminal.output.join("");
		expect(ended).toContain("\x1b[?1006l");
		expect(ended).toContain("\x1b[?1049l");
	});

	it("lays out again at the new width when the terminal resizes", async () => {
		const terminal = fakeTerminal(40, 10);
		const host = mountInk(<Text>{"x".repeat(30)}</Text>, { terminal, screen: "inline" });
		hosts.push(host);
		await vi.waitFor(() => expect(terminal.output.join("")).toContain("x".repeat(30)));
		Object.assign(terminal, { columns: 20 });
		terminal.output.length = 0;
		host.resized();
		await vi.waitFor(() => expect(terminal.output.join("")).toContain("x".repeat(20)));
		expect(terminal.output.join("")).not.toContain("x".repeat(21));
	});
});
