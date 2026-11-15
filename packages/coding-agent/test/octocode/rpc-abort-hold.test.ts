import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { validateRpcCommand } from "../../src/modes/rpc/rpc-command-schema.ts";
import { killEverything, sandbox, script, startEndpoint } from "./e2e-real-process-harness.ts";
import { seedTrust } from "./e2e-helpers/seed-trust.ts";

afterEach(async () => {
	await killEverything();
});

it("accepts only the explicit terminal abort hold", () => {
	expect(validateRpcCommand({ type: "abort" }).ok).toBe(true);
	expect(validateRpcCommand({ type: "abort", holdShutdown: true }).ok).toBe(true);
	expect(validateRpcCommand({ type: "abort", holdShutdown: false }).ok).toBe(false);
	expect(validateRpcCommand({ type: "abort", holdShutdown: "true" }).ok).toBe(false);
});

it.each(["default", "eof", "signal"] as const)(
	"honors extension shutdown after abort while preserving terminal hold (%s)",
	async (finish) => {
		const endpoint = await startEndpoint();
		const box = sandbox(endpoint);
		seedTrust(box);
		const marker = path.join(box.root, "extension-shutdown");
		const fixture = path.join(box.root, "rpc-hold.mjs");
		const moduleUrl = (file: string) =>
			JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../../", file)).href);
		fs.writeFileSync(
			fixture,
			`import fs from "node:fs"; import path from "node:path";
await import(${moduleUrl("scripts/source-resolver.ts")});
const { createAgentSessionServices } = await import(${moduleUrl("src/core/agent-session-services.ts")});
const { createSessionFromServices } = await import(${moduleUrl("src/core/agent-session/create-session.ts")});
const { AgentSessionRuntime } = await import(${moduleUrl("src/core/agent-session-runtime.ts")});
const { SessionManager } = await import(${moduleUrl("src/core/session-manager.ts")});
const { runRpcMode } = await import(${moduleUrl("src/modes/rpc/rpc-mode.ts")});
const shutdownExtension = api => {
  api.on("agent_end", (_event, ctx) => {
    fs.writeFileSync(${JSON.stringify(marker)}, "shutdown requested");
    ctx.shutdown();
  });
};
const cwd = process.cwd();
const services = await createAgentSessionServices({ cwd,
  agentDir: path.join(process.env.HOME, ".octocode", "octocodecode"),
  resourceLoaderOptions: { extensionFactories: [{ name: "shutdown-fixture", factory: shutdownExtension }], noSkills: true, noContextFiles: true }
});
const { session } = await createSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), model: services.modelRuntime.getModel("scripted", "model") });
const runtime = new AgentSessionRuntime(session, services, async () => { throw new Error("No fixture session replacement"); });
await runRpcMode(runtime);
`,
		);
		const run = box.start([], { stdin: "pipe", trust: false, cli: fixture });
		const records = () =>
			run
				.stdout()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		const response = (id: string) => records().find((row) => row.type === "response" && row.id === id);
		const send = (command: Record<string, unknown>) => run.process.stdin?.write(`${JSON.stringify(command)}\n`);
		try {
			await vi.waitFor(
				() =>
					expect(
						records().some((row) => row.type === "rpc_ready"),
						run.stderr(),
					).toBe(true),
				{ timeout: 20_000 },
			);
			send({ type: "prompt", id: "work", message: script([{ hang: true }]), waitForCompletion: true });
			await vi.waitFor(() => expect(endpoint.requests).toHaveLength(1), { timeout: 20_000 });
			send({ type: "abort", id: "stop", ...(finish === "default" ? {} : { holdShutdown: true }) });
			await vi.waitFor(() => expect(fs.existsSync(marker), run.stderr()).toBe(true), { timeout: 20_000 });
			if (finish !== "default") {
				await vi.waitFor(() => expect(response("stop")).toMatchObject({ success: true }));
				await vi.waitFor(() =>
					expect(response("work")).toMatchObject({ success: false, error: "Prompt dispatch cancelled" }),
				);
				expect(run.process.exitCode).toBeNull();
				const later = [
					{ type: "prompt", message: script([{ text: "must not run" }]) },
					{ type: "steer", message: "must not queue" },
					{ type: "follow_up", message: "must not queue" },
					{ type: "get_state" },
				];
				for (const [index, command] of later.entries()) send({ ...command, id: `later-${index}` });
				for (const index of later.keys()) {
					await vi.waitFor(() =>
						expect(response(`later-${index}`)).toMatchObject({
							success: false,
							error: expect.stringContaining("shutdown"),
						}),
					);
				}
				send({ type: "abort", id: "again" });
				await vi.waitFor(() => expect(response("again")).toMatchObject({ success: true }));
				expect(endpoint.requests).toHaveLength(1);
				expect(run.process.exitCode).toBeNull();
				if (finish === "eof") run.process.stdin?.end();
				else run.process.kill("SIGTERM");
			}
			const exited = await run.exited;
			expect(exited.code).toBe(finish === "signal" ? 143 : 0);
			expect(box.survivors()).toEqual([]);
		} finally {
			await killEverything();
			await endpoint.close();
		}
	},
	60_000,
);
