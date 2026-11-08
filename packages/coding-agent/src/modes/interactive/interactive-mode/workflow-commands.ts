import { getApplicationPort } from "../../../core/application/index.ts";
import { renderContextReport } from "../../../core/agent-session/context-report.ts";
import { sideQuestionsFor } from "../../../core/agent-session/side-questions.ts";
import type { InteractiveModeHost } from "./host.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { handleContextSize } from "./context-controls.ts";
import { appendReport } from "./report-block.ts";
import { fence } from "../../../octocode/shared/archive/text.ts";

type Host = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "getMarkdownThemeWithSettings"
	| "session"
	| "showExtensionSelector"
	| "showStatus"
	| "showWarning"
	| "ui"
>;

const BTW_USAGE =
	"Usage: /btw <question>. Answers use existing context, without tools. /btw --cancel stops a running question and /btw --clear clears the side thread.";
const ANSWERING = "Answering… (/btw --cancel to stop)";

/** /context, /btw and /diff add their report to the message list; none of them opens an overlay. */
export async function handleWorkflowCommand(host: Host, name: string, args: string): Promise<void> {
	const port = getApplicationPort(host.session);
	if (name === "context") {
		if (await handleContextSize(host, args)) return;
		appendReport(host, "Context", renderContextReport(port.invoke("getContextReport"), args === "all"));
	} else if (name === "btw") {
		const service = sideQuestionsFor(host.session);
		if (args === "--clear") {
			service.clear();
			host.showStatus("Side thread cleared.");
		} else if (args === "--cancel") {
			if (service.snapshot().running) service.cancel();
			else host.showStatus("No side question is running.");
		} else if (args) {
			if (service.snapshot().running)
				return host.showWarning("A side question is already running. Use /btw --cancel to stop it.");
			const block = appendReport(host, "Side question", `**Question:** ${args}\n\n${ANSWERING}`);
			// The service owns errors and usage; the block shows only this question's exchange.
			void port.invoke("askSideQuestion", args).then(
				(answer) => block.update(`**Question:** ${args}\n\n${answer}`),
				(error) => block.update(`**Question:** ${args}\n\n${errorMessage(error)}`),
			);
		} else {
			const view = (): string => {
				const state = service.snapshot();
				return (
					[
						...state.exchanges.map((item) => `**Question:** ${item.question}\n\n${item.answer}`),
						state.running ? `**Question:** ${state.question}\n\n${ANSWERING}` : "",
						state.error ?? "",
					]
						.filter(Boolean)
						.join("\n\n---\n\n") || BTW_USAGE
				);
			};
			const text = view();
			if (text === BTW_USAGE) return host.showWarning(BTW_USAGE);
			const block = appendReport(host, "Side thread", text);
			if (service.snapshot().running) {
				// Follow the running request; once it settles the block keeps its final text.
				const unsubscribe = service.subscribe(() => {
					block.update(view());
					if (!service.snapshot().running) unsubscribe();
				});
			}
		}
	} else if (name === "diff") {
		const block = appendReport(host, "Repository diff", "Reading repository changes…");
		try {
			const diff = await port.invoke("getRepositoryDiff", args || undefined);
			// Fences sized to the content: a diff that itself contains ``` cannot close the block early.
			let text = `Snapshot: ${new Date().toISOString()}\nAll repository changes; ownership is not inferred.\n\n## Staged\n\n${fence(diff.staged || "No staged changes.", "diff")}\n\n## Unstaged\n\n${fence(diff.unstaged || "No unstaged changes.", "diff")}\n\n## Untracked\n\n${diff.untracked.map((file) => JSON.stringify(file)).join("\n") || "None."}${diff.truncated ? "\n\n[Output truncated.]" : ""}`;
			if (diff.selectedUntracked) {
				const file = diff.selectedUntracked;
				const content = await port.invoke("getUntrackedDiff", diff.root, file);
				text += `\n\n## Selected untracked file: ${JSON.stringify(file)}\n\n${fence(content)}`;
			} else if (diff.untracked.length) text += "\n\nUse /diff <path> to inspect one untracked file.";
			block.update(text);
		} catch (error) {
			block.update(errorMessage(error));
		}
	}
}
