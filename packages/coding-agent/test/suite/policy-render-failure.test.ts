import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@octocodeai/octocode-ai";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai/compat";
import { expect, it, vi } from "vitest";
import type * as PromptTemplate from "../../src/core/prompt-template.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { PolicyRenderError } from "../../src/core/system-prompt-spec.ts";
import { createHarness, type Harness } from "./harness.ts";

/** The section template that fails to render, as a template naming a value the code does not pass would. */
const broken = vi.hoisted(() => ({ section: undefined as string | undefined }));
vi.mock("../../src/core/prompt-template.ts", async (importOriginal) => {
	const original = await importOriginal<typeof PromptTemplate>();
	return {
		...original,
		renderInstruction: (name: string, values?: Parameters<typeof original.renderInstruction>[1]) => {
			if (broken.section !== undefined && name === `sections/${broken.section}.md`)
				throw new Error('Instruction template: unknown name "missing"');
			return original.renderInstruction(name, values);
		},
	};
});

/**
 * A policy section that fails to render fails the run, in a real session: the prompt is rejected with an error naming
 * the section, the model is not called, and nothing starts without `work`, `safety` and the other policy sections.
 * An ordinary handler error stays contained, and the session works again once the template renders.
 */
it("fails the run loudly when a policy section does not render, instead of starting without policy", async () => {
	const root = mkdtempSync(join(tmpdir(), "octocode-policy-render-"));
	const errors: string[] = [];
	const prompts: string[] = [];
	let throwOrdinary = false;
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
			disabledFeatures: ["mcp", "llama.cpp"],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(api) => {
					api.on("before_agent_start", async () => {
						if (throwOrdinary) throw new Error("an ordinary handler error");
					});
				},
			],
		});
		await loader.reload();
		harness = await createHarness({ resourceLoader: loader });
		await harness.session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
		harness.session.setActiveToolsByName(["bash", "file", "agent"]);
		const answer = (text: string) => (context: { messages: Parameters<typeof getCurrentSystemPrompt>[0] }) => {
			prompts.push(getCurrentSystemPrompt(context.messages));
			return fauxAssistantMessage(text);
		};

		for (const section of ["work", "safety", "communication"]) {
			broken.section = section;
			harness.setResponses([answer("must not be asked")]);
			const failure = await harness.session.prompt("Do the task.").then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure, section).toBeInstanceOf(PolicyRenderError);
			expect((failure as Error).message).toContain(`The \`${section}\` prompt section failed to render`);
			expect((failure as Error).message).toContain('unknown name "missing"');
			// The model was never called, so no request went out without the policy.
			expect(prompts).toEqual([]);
			expect(errors.at(-1)).toContain(`The \`${section}\` prompt section failed to render`);
		}

		// The template renders again: the session is not left busy or broken, and the prompt carries the policy.
		broken.section = undefined;
		harness.setResponses([answer("done")]);
		await harness.session.prompt("Do the task.");
		expect(prompts).toHaveLength(1);
		for (const name of ["work", "safety", "communication"]) expect(prompts[0]).toContain(`<${name}>`);

		// Any other handler error is still contained: it is reported and the run goes on with its policy.
		throwOrdinary = true;
		errors.length = 0;
		harness.setResponses([answer("done again")]);
		await harness.session.prompt("Once more.");
		expect(errors).toEqual(["an ordinary handler error"]);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("<work>");
	} finally {
		broken.section = undefined;
		await harness?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness?.cleanup();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});
