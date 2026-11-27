/**
 * Writes the exact final prompt of the main agent and each subagent to a temp folder: what each one receives with its
 * first model request, captured from a real session on a scripted model. Every build runs this (`--fail-open`, so a
 * capture problem warns rather than fails the build). It also writes the templated, committed copy to `src/octocode/native/prompts/final/` (see `final/README.md`).
 *
 * `--exposure <mcpExposure value>` captures every agent under that setting instead of the default (for example `direct`,
 * every tool declared in full) into `.octocode/agent/tmp/agent-prompts-exposure-<value>/`, and leaves the default capture and the
 * committed copy alone: the way to compare request shapes.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { AGENT_DIR, AGENT_FOLDERS } from "../src/storage/agent-layout.ts";
import { captureAll, captureDesktop } from "../test/octocode/agent-context/capture.ts";
import { finalFiles } from "../test/octocode/agent-context/final-prompt.ts";
import {
	renderIndex,
	renderMessages,
	renderSystem,
	renderTools,
	systemText,
} from "../test/octocode/agent-context/render.ts";

const REPOSITORY = path.resolve(import.meta.dirname, "..", "..", "..");
const FINAL = path.join(import.meta.dirname, "..", "src", "octocode", "native", "prompts", "final");
const OUTPUT = path.join(REPOSITORY, AGENT_DIR, AGENT_FOLDERS.tmp, "agent-prompts");

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

function writeContext(folder: string, context: Awaited<ReturnType<typeof captureAll>>[number]): void {
	fs.writeFileSync(path.join(folder, "system.md"), renderSystem(context));
	fs.writeFileSync(path.join(folder, "tools.md"), renderTools(context));
	fs.writeFileSync(path.join(folder, "messages.md"), renderMessages(context));
	fs.writeFileSync(
		path.join(folder, "request.json"),
		`${JSON.stringify({ system: systemText(context), tools: context.tools, messages: context.messages }, null, "\t")}\n`,
	);
}

const { values: options } = parseArgs({
	options: { "fail-open": { type: "boolean" }, exposure: { type: "string" } },
	strict: true,
});

async function main(): Promise<void> {
	const exposure = options.exposure;
	const contexts = await captureAll(exposure ? { mcpExposure: exposure } : undefined);
	assertPolicySections(contexts);
	if (captureDesktop()) {
		// Opt-in desktop capture: only the desktop child, never the committed copy or the other agents' folders.
		const context = contexts.find((candidate) => candidate.name === "desktop");
		if (!context) throw new Error("no desktop capture");
		const folder = path.join(OUTPUT, "desktop");
		fs.rmSync(folder, { recursive: true, force: true });
		fs.mkdirSync(folder, { recursive: true });
		writeContext(folder, context);
		console.log(`Desktop prompt: ${path.relative(REPOSITORY, folder)}/`);
		return;
	}
	const output = exposure ? `${OUTPUT}-exposure-${exposure.replace(/[^\w-]/g, "-")}` : OUTPUT;
	const staging = `${output}.${process.pid}`;
	fs.rmSync(staging, { recursive: true, force: true });
	for (const context of contexts) {
		const folder = path.join(staging, context.name);
		fs.mkdirSync(folder, { recursive: true });
		writeContext(folder, context);
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
