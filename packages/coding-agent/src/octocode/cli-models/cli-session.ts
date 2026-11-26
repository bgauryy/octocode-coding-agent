import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Message, Model } from "@octocodeai/octocode-ai";
import { createEmptyUsage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { stopTree } from "../shared/process.ts";
import type { CliModelRoute } from "./route.ts";
import type { Segment } from "./segment.ts";
import { appendedPrompt, promptText, unseen } from "./transcript.ts";

/** How much of the CLI's stderr a failure quotes. */
const STDERR_TAIL = 2_000;

/** The CLI's arguments for `model`: each `{model}` becomes the model id. */
const cliArgs = (route: CliModelRoute, model: string): string[] =>
	route.args.map((arg) => arg.replaceAll("{model}", model));

/**
 * One request on a `cli` route: a process of its own, given Octocode's instruction and the whole conversation as text on
 * stdin; its stdout streams back as the reply. It gets no Octocode tools: anything it does, it does with its own tools
 * under its own permissions. The request's signal stops its process tree.
 */
export function runCliTurn(
	route: CliModelRoute,
	model: Model<string>,
	messages: readonly Message[],
	cwd: string,
	signal: AbortSignal,
	out: Segment,
): Promise<void> {
	if (signal.aborted) {
		out.fail("aborted", "Cancelled");
		return Promise.resolve();
	}
	const prompt = `${appendedPrompt(messages, route.instruction)}\n\n${promptText(unseen(messages, undefined, route.provider))}`;
	return new Promise((resolve) => {
		const child = spawn(route.command, cliArgs(route, model.id), {
			cwd,
			env: route.env(model.id),
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		let stderr = "";
		let stopping: Promise<void> | undefined;
		const abort = () => {
			stopping ??= stopTree(child.pid);
		};
		signal.addEventListener("abort", abort, { once: true });
		const finish = (end: () => void) => {
			signal.removeEventListener("abort", abort);
			void (stopping ?? Promise.resolve()).then(() => {
				end();
				resolve();
			});
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (text: string) => out.delta(text));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text: string) => {
			stderr = (stderr + text).slice(-STDERR_TAIL);
		});
		// A CLI that exits before reading its prompt closes stdin: its exit code says what happened.
		child.stdin.on("error", () => undefined);
		child.stdin.end(prompt);
		child.once("error", (error: NodeJS.ErrnoException) =>
			finish(() =>
				out.fail(
					"error",
					error.code === "ENOENT"
						? `${route.name} is unavailable: ${route.command} was not found.`
						: `${route.name} failed: ${errorMessage(error)}`,
				),
			),
		);
		child.once("close", (code, killed) =>
			finish(() => {
				if (signal.aborted) return out.fail("aborted", "Cancelled");
				if (code === 0) return out.done("stop", createEmptyUsage(), randomUUID());
				const detail = stderr.trim() ? `: ${stderr.trim()}` : ".";
				out.fail("error", `${route.name} exited with ${killed ?? `code ${code}`}${detail}`);
			}),
		);
	});
}
