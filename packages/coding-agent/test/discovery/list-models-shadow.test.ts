import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../../src/cli/list-models.ts";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { reportDiagnostics } from "../../src/main/startup.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";
import { createSandbox, type Sandbox, write } from "./fixtures.ts";

let sandbox: Sandbox;
const disposers: Array<(() => void) | undefined> = [];
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose?.();
	vi.restoreAllMocks();
	sandbox.cleanup();
});

const provider = (baseUrl: string) =>
	JSON.stringify({
		providers: { dup: { baseUrl, api: "openai-completions", apiKey: "k", models: [{ id: "m1" }] } },
	});

describe("--list-models override warning", () => {
	it("tells on stderr that Octocode's models.json replaces Pi's definition of the same provider", async () => {
		const own = write(join(sandbox.agentDir, "models.json"), provider("http://octocode.test/v1"));
		const pi = write(join(sandbox.piAgentDir, "models.json"), provider("http://pi.test/v1"));
		const services = await createAgentSessionServices({
			cwd: sandbox.cwd,
			agentDir: sandbox.agentDir,
			resourceLoaderOptions: {
				nativeFeatures: nativeFeatureSet(),
				disabledFeatures: ["mcp"],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		disposers.push(services.dispose);

		// The same two steps `octocode --list-models` runs: startup diagnostics, then the listing.
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		reportDiagnostics(services.diagnostics);
		expect(await listModels(services.modelRuntime)).toBe(0);

		const stderr = stripAnsi(error.mock.calls.map((call) => String(call[0])).join("\n"));
		const shadow = stderr.split("\n").find((line) => line.includes('provider "dup"')) ?? "";
		expect(shadow).toContain(own);
		expect(shadow).toContain(pi);
		expect(shadow).toContain("merges");
		expect(stderr).toContain("Requests now go to octocode.test instead of pi.test.");
		expect(stripAnsi(log.mock.calls.map((call) => String(call[0])).join("\n"))).toContain("dup");
	});
});
