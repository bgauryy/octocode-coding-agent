import { createEventBus } from "@octocodeai/octocode-agent-core";
import { describe, expect, it } from "vitest";
import { setMcpSessionStatus } from "../../../mcp/src/status.ts";
import { BASH_READER, type FileGuard, mcpReader } from "../../src/octocode/files/tool/guard.ts";
import { registerReaderRole } from "../../src/octocode/session-guards.ts";
import { fakeHost } from "./fake-host.ts";
import { RESEARCH, useResearchRoles } from "./fake-research-roles.ts";

describe("the file guard's reader role", () => {
	useResearchRoles();
	const guardFor = () => {
		const fake = fakeHost();
		// A real bus: the reader follows the MCP status published on it.
		fake.flat.events = createEventBus();
		const guard = { reader: BASH_READER } as FileGuard;
		registerReaderRole(fake.api, guard);
		const publish = (state: string) =>
			setMcpSessionStatus(fake.api.channels, [
				{ name: RESEARCH.server, enabled: true, state, exposure: "direct", toolCount: 0, source: "test" },
			]);
		return { guard, publish };
	};

	it("names the research server's reader while it may run, and bash while the security review holds it back", () => {
		const { guard, publish } = guardFor();
		publish("starting");
		expect(guard.reader.name).toBe(mcpReader(RESEARCH.reader).name);
		publish("not checked");
		expect(guard.reader).toBe(BASH_READER);
	});
});
