import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPromptSections } from "../../src/core/system-prompt.ts";
import { defaultToolNames } from "../../src/core/native-tools.ts";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

type Registered = { name: string; promptSnippet?: string; defaultActive?: boolean };

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	// Hermetic: a run inside an Octocode agent inherits its identity, which changes the registered tools.
	for (const key of Object.keys(process.env)) if (key.startsWith("OCTOCODE_")) delete process.env[key];
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	process.env = saved;
});

async function nativeTools(): Promise<Registered[]> {
	const fake = fakeHost();
	Object.assign(fake.api, { getSessionName: () => undefined });
	await octocode(fake.api);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
	Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
	await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	return fake.api.getAllTools() as Registered[];
}

describe("native tools and the system prompt", () => {
	it("gives every native tool a one-line trigger and lists each in <tools>", async () => {
		const tools = await nativeTools();
		expect(tools.length).toBeGreaterThan(5);
		// A native tool without a `promptSnippet` is missing from <tools>: add a one-line trigger (when to use it) in its file.
		expect(
			tools.filter((tool) => !tool.promptSnippet?.trim()).map((tool) => tool.name),
			"native tools without a promptSnippet",
		).toEqual([]);
		for (const tool of tools) expect(tool.promptSnippet, `${tool.name} snippet is one line`).not.toMatch(/[\r\n]/);
		const section = buildSystemPromptSections({
			cwd: "/tmp",
			selectedTools: tools.map((tool) => tool.name),
			toolSnippets: Object.fromEntries(tools.map((tool) => [tool.name, tool.promptSnippet!])),
		}).tools;
		for (const tool of tools) expect(section, `<tools> lists ${tool.name}`).toContain(`\n- ${tool.name}: `);
	});

	it("declares `debug` by default and `ollama` only when the user names it", async () => {
		const fake = fakeHost();
		Object.assign(fake.api, { getSessionName: () => undefined });
		await octocode(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const tools = fake.api.getAllTools() as Registered[];
		expect(tools.find((tool) => tool.name === "ollama")?.defaultActive).toBe(false);
		expect(tools.find((tool) => tool.name === "debug")?.defaultActive).not.toBe(false);
		const names = defaultToolNames([
			{
				sourceInfo: { path: "<inline:octocode>" },
				tools: new Map(tools.map((tool) => [tool.name, { definition: tool }])),
			} as never,
		]);
		expect(names).toContain("debug");
		expect(names).not.toContain("ollama");
	});
});
