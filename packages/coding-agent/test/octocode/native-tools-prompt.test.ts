import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPromptSections } from "../../src/core/system-prompt.ts";
import { defaultToolNames } from "../../src/core/native-tools.ts";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

type Registered = { name: string; promptSnippet?: string; defaultActive?: boolean };

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	// Hermetic: a run inside an Octocode agent inherits its identity, which changes the registered tools.
	resetOctocodeEnv();
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

	it("names the tool in rules that would otherwise lose it, so saving a memory is findable from the rules", async () => {
		const tools = (await nativeTools()) as Array<Registered & { promptGuidelines?: string[] }>;
		const of = (name: string) => tools.find((tool) => tool.name === name);
		expect(of("memory")?.promptGuidelines?.[0]).toMatch(/^Save with `memory` when/);
		// History has no rule of its own: `archive` no longer carries the memory guidance.
		expect(of("archive")?.promptGuidelines ?? []).toEqual([]);
		expect(of("backlog")?.promptGuidelines?.[0]).toMatch(/^Claim the `backlog` item/);
	});

	it("asks for handoff notes before a handoff, not before a compaction the agent cannot time", () => {
		const policy = readFileSync(new URL("../../src/octocode/instructions/policy/work.md", import.meta.url), "utf8");
		expect(policy).toMatch(
			/Preserve goal, constraints, checked state, open decisions, pending effects and next step[^\n]*in a handoff or scratch file/,
		);
		expect(policy).not.toMatch(/before a[^.\n]*compaction/i);
	});

	it("declares bash by default, and its line leaves research routing to the policy", async () => {
		const fake = fakeHost();
		Object.assign(fake.api, { getSessionName: () => undefined });
		await octocode(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		Object.assign(ctx.ui, { onTerminalInput: () => () => undefined });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const tools = fake.api.getAllTools() as Registered[];
		// The local-model tool was removed on 2026-11-02; nothing registers it.
		expect(tools.find((tool) => tool.name === "ollama")).toBeUndefined();
		// Research routing has one owner per session: `policy/research.md` with a research server, `system/rules-bash.md`
		// without one. A routing clause on the bash line repeated it and read as a contradiction where no search tool exists.
		const snippet = tools.find((tool) => tool.name === "bash")?.promptSnippet ?? "";
		expect(snippet).toContain("Run builds, tests, git");
		expect(snippet).not.toMatch(/search and read tools|`rg`/);
		const research = readFileSync(
			new URL("../../src/octocode/instructions/policy/research.md", import.meta.url),
			"utf8",
		);
		expect(research).toContain("A quick fetch of one known file or a command's output may use bash");
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
