/**
 * Writes the exact final prompt of the main agent and each subagent to a temp folder: what each one receives with its
 * first model request, captured from a real session on a scripted model. Every build runs this (`--fail-open`, so a
 * capture problem warns rather than fails the build); `scripts/agent-eval/understand.mjs` reads the result. It also
 * writes the templated, committed copy to `src/octocode/instructions/final/` (see `final/README.md`).
 *
 * `--exposure <mcpExposure value>` captures every agent under that setting instead of the default (for example `direct`,
 * every tool declared in full) into `.octocode/tmp/agent-prompts-exposure-<value>/`, and leaves the default capture and the
 * committed copy alone: the way to compare request shapes (`scripts/agent-capture/request-size.mjs`).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { captureAll } from "../test/octocode/agent-context/capture.ts";
import { finalFiles } from "../test/octocode/agent-context/final-prompt.ts";
import {
	renderIndex,
	renderMessages,
	renderSystem,
	renderTools,
	systemText,
} from "../test/octocode/agent-context/render.ts";

const REPOSITORY = path.resolve(import.meta.dirname, "..", "..", "..");
const FINAL = path.join(import.meta.dirname, "..", "src", "octocode", "instructions", "final");
const OUTPUT = path.join(REPOSITORY, ".octocode", "tmp", "agent-prompts");

/**
 * A policy template that fails to render (an undeclared name, say) is reported as a handler error and the session
 * starts without its policy: the capture then succeeds with a prompt that has no `work` section. Nothing is written in
 * that case, so a broken template cannot replace the committed prompts unnoticed.
 */
function assertPolicySections(contexts: Awaited<ReturnType<typeof captureAll>>): void {
	for (const context of contexts) {
		const required = context.name === "lean" ? ["lean"] : ["work", "communication"];
		const present = new Set(context.sections.map((section) => section.name));
		const missing = required.filter((name) => !present.has(name));
		if (missing.length > 0)
			throw new Error(
				`the ${context.name} prompt has no ${missing.join(", ")} section: a policy template failed to render (the prompt tests name the error)`,
			);
	}
}

const { values: options } = parseArgs({
	options: { "fail-open": { type: "boolean" }, exposure: { type: "string" } },
	strict: true,
});

async function main(): Promise<void> {
	const exposure = options.exposure;
	const contexts = await captureAll(exposure ? { mcpExposure: exposure } : undefined);
	assertPolicySections(contexts);
	const output = exposure ? `${OUTPUT}-exposure-${exposure.replace(/[^\w-]/g, "-")}` : OUTPUT;
	const staging = `${output}.${process.pid}`;
	fs.rmSync(staging, { recursive: true, force: true });
	for (const context of contexts) {
		const folder = path.join(staging, context.name);
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, "system.md"), renderSystem(context));
		fs.writeFileSync(path.join(folder, "tools.md"), renderTools(context));
		fs.writeFileSync(path.join(folder, "messages.md"), renderMessages(context));
		fs.writeFileSync(
			path.join(folder, "request.json"),
			`${JSON.stringify({ system: systemText(context), tools: context.tools, messages: context.messages }, null, "\t")}\n`,
		);
	}
	fs.writeFileSync(path.join(staging, "README.md"), renderIndex());
	fs.rmSync(output, { recursive: true, force: true });
	fs.renameSync(staging, output);
	if (exposure) {
		console.log(`Agent prompts (mcpExposure ${exposure}): ${path.relative(REPOSITORY, output)}/`);
		return;
	}
	// The committed, templated copy: the same capture, with machine-specific parts as placeholders.
	fs.rmSync(FINAL, { recursive: true, force: true });
	fs.mkdirSync(FINAL, { recursive: true });
	for (const [name, text] of finalFiles(contexts)) fs.writeFileSync(path.join(FINAL, name), text);
	console.log(
		`Agent prompts: ${path.relative(REPOSITORY, OUTPUT)}/ (${contexts.map((context) => context.name).join(", ")})`,
	);
}

try {
	await main();
	// A capture leaves its sessions' handles open; this script has nothing else to wait for.
	process.exit(0);
} catch (error) {
	const failOpen = options["fail-open"] === true;
	console.warn(
		`${failOpen ? "Warning: " : ""}could not write the agent prompts: ${(error as Error).stack ?? String(error)}`,
	);
	process.exit(failOpen ? 0 : 1);
}
