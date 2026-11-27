import { join } from "node:path";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { checkProviderAuth, formatAuthCheck } from "../../src/cli/auth-check.ts";
import { listModels } from "../../src/cli/list-models.ts";
import { providerRows } from "../../src/cli/providers-command.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelConfig } from "../../src/core/model-config.ts";
import { resolveCliModel } from "../../src/core/model-resolver.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createSandbox, type Sandbox, write } from "./fixtures.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const entry = (apiKey: string | undefined, baseUrl = "http://localhost:1/v1") => ({
	baseUrl,
	...(apiKey === undefined ? {} : { apiKey }),
	api: "openai-completions",
	models: [{ id: "m1" }],
});
const file = (providers: Record<string, unknown>) => JSON.stringify({ providers });

async function runtime(trusted: boolean): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory({}),
		modelsPath: join(sandbox.agentDir, "models.json"),
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
		project: { cwd: sandbox.cwd, isTrusted: () => trusted },
	});
}

describe("auth check causes", () => {
	it("gives each provider its own cause and keeps a broken one from marking the others", async () => {
		write(
			join(sandbox.agentDir, "models.json"),
			file({
				broken: entry("!echo super-secret-value; exit 3"),
				unset: entry("$DIAG_KEY_NOT_SET"),
				good: entry("literal-key"),
			}),
		);
		const rt = await runtime(false);
		try {
			const good = await checkProviderAuth(parseArgs(["--provider", "good"]), rt);
			expect(good.status).toBe("ready");

			const broken = await checkProviderAuth(parseArgs(["--provider", "broken"]), rt, { refresh: true });
			expect(broken).toMatchObject({ status: "invalid", reason: "invalid_state" });
			expect(broken.detail).toContain("exited with status 3");
			expect(formatAuthCheck(broken)).not.toContain("super-secret-value");

			const unset = await checkProviderAuth(parseArgs(["--provider", "unset"]), rt);
			expect(unset).toMatchObject({ status: "not_ready", reason: "credentials_not_configured" });
			expect(unset.detail).toBe("environment variable DIAG_KEY_NOT_SET is not set");
		} finally {
			rt.dispose();
		}
	});

	it("does not call another provider invalid because one models.json file is unreadable", async () => {
		write(join(sandbox.agentDir, "models.json"), file({ good: entry("literal-key") }));
		write(join(sandbox.home, ".octocode", "models.json"), "{ not json");
		const rt = await runtime(false);
		try {
			expect(rt.getError()).toBeDefined();
			expect((await checkProviderAuth(parseArgs(["--provider", "good"]), rt)).status).toBe("ready");
		} finally {
			rt.dispose();
		}
	});
});

describe("untrusted workspace models.json", () => {
	const wsFile = () => join(sandbox.cwd, ".octocode", "models.json");

	it("names `octocode trust add` for a provider and a model only that file defines", async () => {
		write(wsFile(), file({ "ws-only": entry("k") }));
		const rt = await runtime(false);
		try {
			const result = await checkProviderAuth(parseArgs(["--provider", "ws-only"]), rt);
			expect(result).toMatchObject({ status: "not_ready", reason: "provider_not_found" });
			expect(result.detail).toContain(`octocode trust add ${sandbox.cwd}`);

			const byProvider = resolveCliModel({ cliProvider: "ws-only", cliModel: "m1", modelRuntime: rt });
			expect(byProvider.error).toContain("octocode trust add");
			const byModel = resolveCliModel({ cliModel: "ws-only/m1", modelRuntime: rt });
			expect(byModel.error).toContain("octocode trust add");
			expect(resolveCliModel({ cliModel: "nowhere-model", modelRuntime: rt }).error).not.toContain("trust");
		} finally {
			rt.dispose();
		}
	});

	it("names `octocode trust add` and exits 1 for --list-models --provider of such a provider", async () => {
		write(wsFile(), file({ "ws-only": entry("k") }));
		write(join(sandbox.agentDir, "models.json"), file({ own: entry("k") }));
		const rt = await runtime(false);
		const errors: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((text: unknown) => errors.push(String(text)));
		try {
			expect(await listModels(rt, undefined, undefined, { provider: "ws-only" })).toBe(1);
			expect(errors.join("\n")).toContain(`octocode trust add ${sandbox.cwd}`);
		} finally {
			spy.mockRestore();
			rt.dispose();
		}
	});

	it("loads the provider once the folder is trusted", async () => {
		write(wsFile(), file({ "ws-only": entry("k") }));
		const rt = await runtime(true);
		try {
			expect((await checkProviderAuth(parseArgs(["--provider", "ws-only"]), rt)).status).toBe("ready");
		} finally {
			rt.dispose();
		}
	});
});

describe("provider sources and shadowing", () => {
	const own = () => join(sandbox.agentDir, "models.json");

	it("warns for every override, Pi or Octocode, global or workspace, once each", async () => {
		write(own(), file({ dup: entry("k", "http://octocode.test/v1") }));
		write(join(sandbox.piAgentDir, "models.json"), file({ dup: entry("k", "http://pi.test/v1") }));
		write(join(sandbox.cwd, ".octocode", "models.json"), file({ dup: entry("k", "http://ws.test/v1") }));
		const config = await ModelConfig.load(own(), { cwd: sandbox.cwd, isTrusted: () => true });
		const replaces = config.getWarnings().filter((warning) => warning.includes("merges over"));
		expect(replaces).toHaveLength(2);
		expect(config.diagnostics.getShadowedDefinitions().map((s) => s.file)).toEqual([
			own(),
			join(sandbox.piAgentDir, "models.json"),
		]);
		expect(config.diagnostics.describeFile(join(sandbox.piAgentDir, "models.json"))).toMatchObject({
			scope: "global",
			product: "Pi",
		});
		expect(config.diagnostics.describeFile(join(sandbox.cwd, ".octocode", "models.json"))).toMatchObject({
			scope: "workspace",
			product: "Octocode",
		});
	});

	it("lists each provider with its source and the files it shadows", async () => {
		write(own(), file({ dup: entry("k"), mine: entry("k") }));
		write(join(sandbox.piAgentDir, "models.json"), file({ dup: entry("k") }));
		const rt = await runtime(false);
		try {
			const rows = providerRows(rt);
			expect(rows.find((row) => row.id === "mine")?.source).toMatchObject({ scope: "global", product: "Octocode" });
			expect(rows.find((row) => row.id === "openai")?.source).toBe("built-in");
			const shadowed = rows.find((row) => row.shadowedBy);
			expect(shadowed).toMatchObject({ id: "dup", source: { product: "Pi" }, shadowedBy: own() });
		} finally {
			rt.dispose();
		}
	});
});
