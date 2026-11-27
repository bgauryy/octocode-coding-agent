import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultToolNames } from "../../src/core/native-tools.ts";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	resetOctocodeEnv();
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	process.env = saved;
});

describe("native tool registration", () => {
	it("declares bash by default and does not register ollama", async () => {
		const fake = fakeHost();
		Object.assign(fake.api.session, { getName: () => undefined });
		await octocode(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const tools = fake.api.tools.getAll();
		expect(tools.find((tool) => tool.name === "ollama")).toBeUndefined();
		const names = defaultToolNames([
			{
				owner: "native",
				sourceInfo: { owner: "native", path: "<inline:octocode>" },
				tools: new Map(tools.map((tool) => [tool.name, { definition: tool }])),
			} as never,
		]);
		expect(names).toContain("bash");
	});
});
