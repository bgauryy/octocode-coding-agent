import { describe, expect, it } from "vitest";
import { addOptions } from "../src/add-form.ts";
import { mcpNameCollisions } from "../src/add.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

describe("Add MCP name collisions with a queued registry change", () => {
	it("treats a registry server not yet in state.servers as taken", () => {
		const host = mcpHost({ servers: [] });
		// An extension registered this server; the session has not reloaded it into state.servers yet.
		host.api.mcpServers.list = () =>
			[{ name: "queued", config: { type: "stdio", command: "x" }, source: "ext" }] as never;
		expect(host.state.servers.map((server) => server.entry.name)).not.toContain("queued");
		const options = addOptions(host.state);
		expect(mcpNameCollisions(["queued"], options)).toEqual(["queued"]);
	});
});
