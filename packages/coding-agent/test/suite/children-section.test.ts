import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt, getInitialSystemMessage, getSystemMessageText } from "@octocodeai/octocode-ai";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	registerApiProvider,
} from "@octocodeai/octocode-ai/compat";
import { expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

/**
 * A real session on a scripted model: the rules for running children and using reports are absent from the first
 * request, arrive as a section patch in the request that reads the result of the first `agent` call that waits on an
 * agent, stay in every later request, and are back in the first request after the session reloads from its entries.
 */
it("sends the run-and-report rules with the first delegating call and keeps them, without rewriting the first prompt", async () => {
	const root = mkdtempSync(join(tmpdir(), "octocode-children-"));
	const HEADING = "<children>";
	const requests: Array<{ prompt: string; initial: string }> = [];
	const capture = (context: { messages: Parameters<typeof getCurrentSystemPrompt>[0] }) => {
		const initial = getInitialSystemMessage(context.messages);
		requests.push({
			prompt: getCurrentSystemPrompt(context.messages),
			initial: initial ? getSystemMessageText(initial) : "",
		});
	};
	const errors: string[] = [];
	let harness: Harness | undefined;
	for (const [name, value] of Object.entries({
		HOME: root,
		USERPROFILE: root,
		OCTOCODE_HOME: join(root, ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: join(root, ".octocode", "agent"),
		OCTOCODE_MCP: "0",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_EXTRA_SKILLS: "0",
		OCTOCODE_MEMORY_AUTO: "0",
		OCTOCODE_NOTIFY: "off",
		OCTOCODE_PERMISSION: "full",
	}))
		vi.stubEnv(name, value);
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, ".octocode", "agent"),
			settingsManager: SettingsManager.inMemory(),
			nativeFeatures: nativeFeatureSet(),
			disabledFeatures: ["mcp"],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		harness = await createHarness({ resourceLoader: loader });
		const fauxApi = getApiProvider(harness.faux.api);
		if (!fauxApi) throw new Error("Missing faux API");
		await harness.session.bindFeatures({ mode: "rpc", onError: (error) => errors.push(error.error) });
		harness.session.setActiveToolsByName(["bash", "file", "agent"]);

		harness.setResponses([
			(context) => {
				capture(context);
				return fauxAssistantMessage(
					fauxToolCall("agent", { type: "coordinate", action: "list", reason: "See who works here" }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				capture(context);
				return fauxAssistantMessage(
					fauxToolCall("agent", {
						type: "message",
						to: "all",
						message: "What is your state?",
						reason: "Ask the team for its state",
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				capture(context);
				return fauxAssistantMessage("waiting on the team");
			},
		]);
		await harness.session.prompt("Ask the team.");
		expect(requests).toHaveLength(3);
		// Before any delegating call, and after a `coordinate` call: the delegation policy without the rules.
		for (const request of requests.slice(0, 2)) {
			expect(request.prompt).toContain("<delegation>");
			expect(request.prompt).not.toContain(HEADING);
		}
		// The request that reads the message call's result has them, and the first prompt it was cached under is unchanged.
		expect(requests[2].prompt).toContain(HEADING);
		expect(requests[2].initial).toBe(requests[0].initial);
		expect(requests[2].initial).not.toContain(HEADING);

		harness.setResponses([
			(context) => {
				capture(context);
				return fauxAssistantMessage("still waiting");
			},
		]);
		await harness.session.prompt("And now?");
		expect(requests[3].prompt).toBe(requests[2].prompt);

		// A reload drops the in-memory state; the session's entries say it delegated.
		await harness.session.reload();
		registerApiProvider(fauxApi);
		harness.session.setActiveToolsByName(["bash", "file", "agent"]);
		harness.setResponses([
			(context) => {
				capture(context);
				return fauxAssistantMessage("resumed");
			},
		]);
		await harness.session.prompt("Continue.");
		expect(requests[4].prompt).toContain(HEADING);
		expect(errors).toEqual([]);
	} finally {
		await harness?.session.featureHost.emit({ type: "session_shutdown", reason: "quit" });
		harness?.cleanup();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});
