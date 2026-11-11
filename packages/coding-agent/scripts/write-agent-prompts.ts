/**
 * Writes the exact final prompt of the main agent and each subagent to a temp folder: what each one receives with its
 * first model request, captured from a real session on a scripted model. Every build runs this (`--fail-open`, so a
 * capture problem warns rather than fails the build); `scripts/agent-eval/understand.mjs` reads the result. It also
 * writes the templated, committed copy to `src/octocode/instructions/final/` (see `final/README.md`).
 */
import fs from "node:fs";
import path from "node:path";
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

async function main(): Promise<void> {
	const contexts = await captureAll();
	assertPolicySections(contexts);
	const staging = `${OUTPUT}.${process.pid}`;
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
	fs.rmSync(OUTPUT, { recursive: true, force: true });
	fs.renameSync(staging, OUTPUT);
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
	const failOpen = process.argv.includes("--fail-open");
	console.warn(
		`${failOpen ? "Warning: " : ""}could not write the agent prompts: ${(error as Error).stack ?? String(error)}`,
	);
	process.exit(failOpen ? 0 : 1);
}
