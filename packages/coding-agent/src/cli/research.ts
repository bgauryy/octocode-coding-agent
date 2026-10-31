import { spawn } from "node:child_process";
import { constants } from "node:os";
import { getResearchCliInvocation } from "../config.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

export function runResearchCommand(args: string[]): boolean {
	const [kind, ...rest] = args;
	if (kind !== "research" && kind !== "native") return false;
	try {
		const invocation = getResearchCliInvocation(kind);
		const child = spawn(invocation.command, [...invocation.prefix, ...rest], { stdio: "inherit" });
		const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
		const forward = (signal: NodeJS.Signals) => {
			if (child.exitCode === null && child.signalCode === null) child.kill(signal);
		};
		const handlers = signals.map((signal) => {
			const handler = () => forward(signal);
			process.on(signal, handler);
			return { signal, handler };
		});
		const cleanup = () => {
			for (const { signal, handler } of handlers) process.removeListener(signal, handler);
		};
		child.once("error", (error) => {
			cleanup();
			console.error(`Octocode ${kind}: ${error.message}`);
			process.exitCode = 1;
		});
		child.once("close", (code, signal) => {
			cleanup();
			process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
		});
	} catch (error) {
		console.error(errorMessage(error));
		process.exitCode = 1;
	}
	return true;
}
