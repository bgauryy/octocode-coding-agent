import { renderPrompt } from "../../core/prompt-template.ts";
import fs from "node:fs";
import type { ToolResultMessage } from "@octocodeai/octocode-ai";
import type { FeatureSetup } from "../../core/features/index.ts";
import { TEXT_MAX_CHARS, TURN_MAX_CHARS } from "../../utils/output-budget.ts";
import { capResultText, saveFullOutput } from "../shared/spill.ts";
/** Space reserved for the recovery pointer when a turn exhausts its text budget. */
const RECOVERY_CHARS = 1024;
/** What a result after the budget ran out shows: its text is in the archive the first omitted result names. */
const omittedText = (): string => renderPrompt("notices/turn-budget-omitted.md");

/** Bounds one assistant message's tool text; overflow records remain recoverable from the first omitted result's archive. */
export class TurnBudget {
	private used = 0;
	private archive: string | undefined;

	/** The most characters one more text part may keep. */
	limit(): number {
		return Math.min(TEXT_MAX_CHARS, Math.max(0, TURN_MAX_CHARS - this.used - RECOVERY_CHARS));
	}

	charge(chars: number): void {
		this.used += chars;
	}

	/**
	 * What the model gets of one text part of `tool`'s result: the text itself while it fits (a part over
	 * `TEXT_MAX_CHARS` is saved whole and shown as head and tail), else the head and tail of the first text that does not
	 * fit, with the path of the JSON-lines archive that this and every later text of the turn is appended to.
	 */
	text(text: string, tool: string): string {
		const preview = this.archive ? "" : capResultText(text, tool);
		if (this.archive || preview.length > TURN_MAX_CHARS - this.used - RECOVERY_CHARS) {
			const record = `${JSON.stringify({ tool, text })}\n`;
			if (this.archive) {
				fs.appendFileSync(this.archive, record);
				const omitted = omittedText();
				this.charge(omitted.length);
				return omitted;
			}
			const file = saveFullOutput(record, "turn-overflow");
			if (!file) throw new Error("Could not save tool output beyond the turn budget");
			const note = `\n${renderPrompt("notices/turn-budget-reached.md", { file })}`;
			const gap = "\n[…]\n";
			const available = Math.min(
				text.length,
				TEXT_MAX_CHARS - note.length - gap.length,
				Math.max(0, TURN_MAX_CHARS - this.used - note.length - gap.length),
			);
			if (note.length + gap.length > TURN_MAX_CHARS - this.used)
				throw new Error("Tool recovery pointer exceeds remaining turn budget");
			this.archive = file;
			const head = Math.floor(available * 0.7);
			const shown = `${text.slice(0, head)}${gap}${available > head ? text.slice(-(available - head)) : ""}${note}`;
			this.charge(shown.length);
			return shown;
		}
		this.charge(preview.length);
		return preview;
	}

	reset(): void {
		this.used = 0;
		this.archive = undefined;
	}
}

/** `message` with its text parts bounded by `budget`, charged in part order; undefined when every part fits as is. Images are not text and stay. */
export function budgetToolResult(budget: TurnBudget, message: ToolResultMessage): ToolResultMessage | undefined {
	let changed = false;
	const content = message.content.map((part) => {
		if (part.type !== "text") return part;
		const text = budget.text(part.text, message.toolName);
		if (text === part.text) return part;
		changed = true;
		return { ...part, text };
	});
	return changed ? { ...message, content } : undefined;
}

/**
 * One text budget per assistant message for every tool's results, native and MCP alike. The agent loop emits the
 * results of a message in tool-call order however the calls finished (`message_end`), so the budget is spent in that
 * order: the same calls always keep and lose the same text, and the cached prefix does not change with timing. Each
 * tool keeps its own cap; the budget bounds only their sum (results within it are unchanged). A new turn starts it again.
 */
export function registerTurnBudget(api: FeatureSetup, budget = new TurnBudget()): TurnBudget {
	api.bus.on("turn_start", async () => budget.reset());
	api.bus.on("message_end", async (event) => {
		if (event.message.role !== "toolResult") return undefined;
		const bounded = budgetToolResult(budget, event.message);
		return bounded ? { message: bounded } : undefined;
	});
	return budget;
}
