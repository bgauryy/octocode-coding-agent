import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InstalledAcpAgent, installedAcpAgents } from "../../src/octocode/external/discover.ts";
import { describeExternal } from "../../src/octocode/external/describe.ts";
import { ExternalAgents, type ExternalFactories } from "../../src/octocode/external/manager.ts";
import { type ExternalBackend, parseExternalParams } from "../../src/octocode/external/protocol.ts";
import { fakeCtx } from "./fake-host.ts";

const roots: string[] = [];
const managers: ExternalAgents[] = [];
function tempDir() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "external-discovery-")));
	roots.push(root);
	return root;
}
afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((manager) => manager.reset()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const policy = {
	authorize: async () => undefined,
	beforeSend: async () => undefined,
	afterReceive: async () => undefined,
	permission: () => async () => ({ outcome: { outcome: "cancelled" as const } }),
	sender: () => "local-session",
};

function manager(backend: ExternalBackend, discover: () => InstalledAcpAgent[] = () => []) {
	const acp = vi.fn(async (_input: Record<string, unknown>) => backend);
	const agents = new ExternalAgents(policy, { acp, octocode: acp, discover } as unknown as ExternalFactories);
	managers.push(agents);
	return { agents, acp };
}

describe.skipIf(process.platform === "win32")("installed ACP agents", () => {
	it("lists known adapters found as executable files on PATH, with their connect arguments", () => {
		const bin = tempDir();
		const other = tempDir();
		writeFileSync(join(bin, "codex-acp"), "#!/bin/sh\n");
		chmodSync(join(bin, "codex-acp"), 0o755);
		writeFileSync(join(bin, "opencode"), "not executable");
		chmodSync(join(bin, "opencode"), 0o644);
		mkdirSync(join(bin, "claude-agent-acp"));
		writeFileSync(join(other, "gemini"), "#!/bin/sh\n");
		chmodSync(join(other, "gemini"), 0o755);
		expect(installedAcpAgents({ PATH: [bin, other].join(":") })).toEqual([
			{ vendor: "codex", command: "codex-acp", args: [], path: join(bin, "codex-acp") },
			{ vendor: "gemini", command: "gemini", args: ["--acp"], path: join(other, "gemini") },
		]);
		expect(installedAcpAgents({ PATH: "" })).toEqual([]);
	});
});

describe("external agent discovery and models", () => {
	it("lists installed ACP agents beside connections and shows them to the user", async () => {
		const cwd = tempDir();
		const installed = [{ vendor: "codex", command: "codex-acp", args: [], path: "/bin/codex-acp" }];
		const { agents } = manager({ cwd, sessionId: "s" } as ExternalBackend, () => installed);
		const listed = await agents.call({ action: "list" }, fakeCtx({ cwd }));
		expect(listed).toMatchObject({ connections: [], acpAgents: installed });
		const text = describeExternal(listed);
		expect(text).toContain("Installed ACP agents");
		expect(text).toContain("codex · codex-acp · /bin/codex-acp");
	});

	it("passes the requested model to the ACP backend and reports current and offered models", async () => {
		const cwd = tempDir();
		const backend = {
			cwd,
			sessionId: "remote",
			models: { current: "large", available: Array.from({ length: 105 }, (_, index) => `m${index}`) },
			prompt: vi.fn<ExternalBackend["prompt"]>(async () => ({ text: "ok" })),
			cancel: vi.fn<ExternalBackend["cancel"]>(async () => undefined),
			close: vi.fn<ExternalBackend["close"]>(async () => undefined),
		} satisfies ExternalBackend;
		const { agents, acp } = manager(backend);
		const ctx = fakeCtx({ cwd });
		const connected = (await agents.call(
			{ action: "connect", id: "one", transport: "acp", vendor: "fixture", command: "agent", model: "large" },
			ctx,
		)) as Record<string, unknown>;
		expect(acp.mock.calls[0]?.[0]).toMatchObject({ model: "large" });
		expect(connected).toMatchObject({ id: "one", model: "large", modelsMore: 5 });
		expect(connected.models).toHaveLength(100);
		expect(describeExternal(connected)).toContain("model large (105 available)");
		const listed = (await agents.call({ action: "list" }, ctx)) as { connections: Array<Record<string, unknown>> };
		expect(listed.connections[0]).toMatchObject({ id: "one", model: "large" });
		expect(listed.connections[0]).not.toHaveProperty("models");
		expect(await agents.call({ action: "prompt", id: "one", text: "hi" }, ctx)).toMatchObject({ model: "large" });
	});

	it("accepts model only on ACP connect", () => {
		expect(() =>
			parseExternalParams({ action: "connect", transport: "octocode", instanceId: "i", model: "large" }),
		).toThrow("connect does not accept: model.");
		expect(() => parseExternalParams({ action: "prompt", id: "one", text: "x", model: "large" })).toThrow(
			"prompt does not accept: model.",
		);
		expect(() =>
			parseExternalParams({ action: "connect", transport: "acp", vendor: "v", command: "c", model: "m".repeat(201) }),
		).toThrow("model must have at most 200 characters.");
	});
});
