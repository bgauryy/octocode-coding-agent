import { createHash } from "node:crypto";
import { stripTerminalSequences } from "@octocodeai/octocode-common/ansi";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { TerminalCommandRequest, TerminalCommandResult } from "@octocodeai/octocode-contracts/protocol";
import { registerTerminalCommands } from "../../../core/application/terminal-commands.ts";
import { getBuiltinCommand, parseSlashCommand } from "../../../core/slash-commands.ts";
import { menuCommands } from "./command-menu.ts";
import { runBuiltinCommand, slashRefusal } from "./command-dispatch.ts";
import type { InteractiveModeHost } from "./host.ts";
import { withInputOrigin } from "../../../core/input-origin.ts";
import { webCommandContext, type CommandCapture } from "./web-command-context.ts";

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	backspace: "\x7f",
};
type Receipt = Exclude<TerminalCommandResult, { commands: unknown }>;
interface Run {
	id: string;
	name: string;
	fingerprint: string;
	sequence: number;
	capture: CommandCapture;
	finished: boolean;
	error?: string;
}
function activeDialog(run: Run) {
	const { dialog, focused } = run.capture;
	return dialog && focused() === dialog.focus ? dialog : undefined;
}
function receipt(run: Run): Receipt {
	const dialog = activeDialog(run);
	const width = Math.max(20, Math.min(run.capture.ui.terminal.columns, 120));
	const components = dialog ? [dialog.component] : run.capture.output;
	const text =
		run.error ??
		components
			.flatMap((component) => component.render(width))
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n")
			.trim();
	return {
		id: run.id,
		name: run.name,
		sequence: run.sequence,
		phase: run.error ? "failed" : dialog ? "dialog" : run.finished ? "done" : "running",
		text:
			text.length > 32000
				? `${redactSecrets(text.slice(0, 32000))}\n… Output continues in the terminal.`
				: redactSecrets(text),
		...(dialog ? { dialog: dialog.id } : {}),
	};
}

/** Bind to exactly this session. A new session or reload reads the current command registry again. */
export function bindWebCommands(host: InteractiveModeHost): () => void {
	const session = host.session;
	const sessionId = session.sessionId;
	let current: Run | undefined;
	const recent = new Map<string, { fingerprint: string; value: Receipt }>();
	return registerTerminalCommands(session, (request: TerminalCommandRequest): TerminalCommandResult => {
		if (
			host.session !== session ||
			session.sessionId !== sessionId ||
			(request.action !== "list" && request.sessionId !== sessionId)
		)
			throw new Error("Session changed. Reopen Commands.");
		if (request.action === "list")
			return {
				sessionId,
				activeId: current?.id,
				commands: menuCommands(host.getSlashCommands(true)).map(({ name, description, argumentHint, aliases }) => ({
					name,
					description,
					argumentHint,
					aliases,
				})),
			};
		const old = recent.get(request.id);
		const fingerprint =
			request.action === "run"
				? createHash("sha256")
						.update(JSON.stringify([request.name, request.args]))
						.digest("hex")
				: undefined;
		const known = old ?? (current?.id === request.id ? current : undefined);
		if (known && fingerprint && known.fingerprint !== fingerprint)
			throw new Error("This command ID belongs to a different request.");
		if (old) return old.value;
		if (request.action === "status" || request.action === "input") {
			if (!current || current.id !== request.id) throw new Error("This command is no longer active.");
			if (request.action === "input" && request.sequence > current.sequence) {
				const dialog = activeDialog(current);
				if (!dialog || dialog.id !== request.dialog) throw new Error("This dialog changed. Refresh the command.");
				if (request.sequence !== current.sequence + 1) throw new Error("Input arrived out of order.");
				if (!dialog.focus.handleInput) throw new Error("This dialog does not accept keyboard input.");
				const input = request.key === "text" ? Array.from(request.text ?? "") : [KEYS[request.key]];
				current.sequence = request.sequence;
				const run = current;
				webCommandContext.run(run.capture, () => {
					for (const key of input) {
						if (activeDialog(run) !== dialog) break;
						dialog.focus.handleInput!(key);
					}
				});
				host.ui.requestRender();
			}
			return receipt(current);
		}
		if (current?.id === request.id) return receipt(current);
		if (current && (!current.finished || activeDialog(current))) throw new Error("Finish the current command first.");
		if (host.renderer.getFocusedComponent() !== host.editor) throw new Error("Finish the open terminal dialog first.");
		const line = `/${request.name}${request.args ? ` ${request.args}` : ""}`;
		const parsed = parseSlashCommand(line);
		if (!parsed || !host.getSlashCommands(true).some((entry) => entry.name === parsed.name))
			throw new Error("Unknown slash command.");
		const refusal = slashRefusal(host, line, parsed.name, parsed.args);
		if (refusal) throw new Error(refusal);
		if (current) {
			recent.set(current.id, { fingerprint: current.fingerprint, value: receipt(current) });
			if (recent.size > 24) recent.delete(recent.keys().next().value!);
		}
		const run: Run = {
			id: request.id,
			name: request.name,
			fingerprint: fingerprint!,
			sequence: 0,
			capture: {
				owner: Symbol(),
				ui: host.ui,
				focused: () => host.renderer.getFocusedComponent(),
				transcript: host.chatContainer,
				output: [],
			},
			finished: false,
		};
		current = run;
		void webCommandContext.run(run.capture, async () => {
			try {
				await withInputOrigin("web", async () => {
					if (getBuiltinCommand(parsed.name)) await runBuiltinCommand(host, parsed.name, parsed.args);
					else await session.prompt(line, { streamingBehavior: "steer" });
				});
			} catch (error) {
				run.error = errorMessage(error);
			} finally {
				run.finished = true;
			}
		});
		return receipt(run);
	});
}
