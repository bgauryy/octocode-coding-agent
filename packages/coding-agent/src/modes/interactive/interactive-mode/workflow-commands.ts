import { getApplicationPort } from "../../../core/application/index.ts";
import { renderContextReport } from "../../../core/agent-session/context-report.ts";
import { sideQuestionsFor } from "../../../core/agent-session/side-questions.ts";
import { CommandReport } from "../components/command-report.ts";
import type { InteractiveModeHost } from "./host.ts";
import { errorMessage } from "../../../utils/guards.ts";
import { handleContextSize } from "./context-controls.ts";
import { fence } from "../../../octocode/shared/archive/text.ts";

type Host = Pick<
	InteractiveModeHost,
	"session" | "showExtensionCustom" | "showExtensionSelector" | "showStatus" | "ui"
>;
export async function handleWorkflowCommand(host: Host, name: string, args: string): Promise<void> {
	const session = host.session;
	const port = getApplicationPort(session);
	const show = (
		title: string,
		text: () => string,
		cancel?: () => void,
		subscribe?: (listener: () => void) => () => void,
	) =>
		host.showExtensionCustom<void>(
			(tui, _theme, _keys, done) =>
				new CommandReport(
					title,
					text,
					() => done(),
					() => tui.requestRender(),
					cancel,
					subscribe,
				),
			{ overlay: true },
		);
	if (name === "context") {
		if (await handleContextSize(host, args)) return;
		const text = renderContextReport(port.invoke("getContextReport"), args === "all");
		await show("Context", () => text);
	} else if (name === "btw") {
		const service = sideQuestionsFor(session);
		let validationError: string | undefined;
		let changed = () => {};
		if (args === "--clear") {
			service.clear();
			return;
		}
		if (args) {
			if (service.snapshot().running) throw new Error("A side question is already running.");
			// The service owns errors and usage; dismissing its overlay does not cancel the request.
			void port.invoke("askSideQuestion", args).catch((error) => {
				validationError = errorMessage(error);
				changed();
			});
		}
		await show(
			"Side question",
			() => {
				const state = service.snapshot();
				return [
					...state.exchanges.map((item) => `**Question:** ${item.question}\n\n${item.answer}`),
					state.running ? `**Question:** ${state.question}\n\nAnswering…` : "",
					validationError ?? state.error ?? "",
					!state.running && !state.exchanges.length && !state.error
						? "Usage: /btw <question>. Answers use existing context, without tools. /btw --clear clears the side thread."
						: "",
				]
					.filter(Boolean)
					.join("\n\n---\n\n");
			},
			() => service.cancel(),
			(listener) => {
				changed = listener;
				const remove = service.subscribe(listener);
				return () => {
					changed = () => {};
					remove();
				};
			},
		);
	} else if (name === "diff") {
		const controller = new AbortController();
		let text = "Reading repository changes…";
		const listeners = new Set<() => void>();
		const work = port
			.invoke("getRepositoryDiff", args || undefined, controller.signal)
			.then(async (diff) => {
				// Fences sized to the content: a diff that itself contains ``` cannot close the block early.
				text = `Snapshot: ${new Date().toISOString()}\nAll repository changes; ownership is not inferred.\n\n## Staged\n\n${fence(diff.staged || "No staged changes.", "diff")}\n\n## Unstaged\n\n${fence(diff.unstaged || "No unstaged changes.", "diff")}\n\n## Untracked\n\n${diff.untracked.map((file) => JSON.stringify(file)).join("\n") || "None."}${diff.truncated ? "\n\n[Output truncated.]" : ""}`;
				if (diff.selectedUntracked) {
					const file = diff.selectedUntracked;
					const content = await port.invoke("getUntrackedDiff", diff.root, file);
					text += `\n\n## Selected untracked file: ${JSON.stringify(file)}\n\n${fence(content)}`;
				} else if (diff.untracked.length) text += "\n\nUse /diff <path> to inspect one untracked file.";
			})
			.catch((error) => {
				text = errorMessage(error);
			})
			.finally(() => {
				for (const listener of listeners) listener();
			});
		await show(
			"Repository diff",
			() => text,
			undefined,
			(listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		);
		controller.abort();
		await work;
	}
}
