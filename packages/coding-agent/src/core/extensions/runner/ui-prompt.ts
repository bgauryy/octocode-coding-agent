/** Tracking of the outermost UI dialog, reported to extensions as `ui_prompt_start` and `ui_prompt_end`. */

import type { ExtensionUIContext, UIPromptKind } from "../types.ts";
import type { RunnerEmitEvent } from "./types.ts";

type UIPromptEvent = Extract<RunnerEmitEvent, { type: "ui_prompt_start" | "ui_prompt_end" }>;

export class UIPromptTracker {
	private uiPromptDepth = 0;
	private activeUIPrompt: { kind: UIPromptKind; title?: string } | undefined;

	private readonly emit: (event: UIPromptEvent) => Promise<unknown>;

	/** `emit` dispatches an event to the runner's handlers; it is called in a microtask. */
	constructor(emit: (event: UIPromptEvent) => Promise<unknown>) {
		this.emit = emit;
	}

	wrap(ui: ExtensionUIContext): ExtensionUIContext {
		return {
			...ui,
			select: (title, options, opts) => this.withUIPrompt("select", title, () => ui.select(title, options, opts)),
			confirm: (title, message, opts) => this.withUIPrompt("confirm", title, () => ui.confirm(title, message, opts)),
			input: (title, placeholder, opts) => this.withUIPrompt("input", title, () => ui.input(title, placeholder, opts)),
			editor: (title, prefill) => this.withUIPrompt("editor", title, () => ui.editor(title, prefill)),
			custom: (factory, options) => this.withUIPrompt("custom", undefined, () => ui.custom(factory, options)),
		};
	}

	private withUIPrompt<T>(kind: UIPromptKind, title: string | undefined, run: () => Promise<T>): Promise<T> {
		const outerPrompt = this.uiPromptDepth++ === 0;
		if (outerPrompt) {
			this.activeUIPrompt = { kind, title };
			this.emitUIPromptEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind, ...(title ? { title } : {}) });
		}

		const finish = () => {
			if (--this.uiPromptDepth > 0) return;
			this.uiPromptDepth = 0;

			const prompt = this.activeUIPrompt ?? { kind, title };
			this.activeUIPrompt = undefined;
			this.emitUIPromptEvent({
				type: "ui_prompt_end",
				reason: "ui_prompt",
				kind: prompt.kind,
				...(prompt.title ? { title: prompt.title } : {}),
			});
		};

		try {
			return run().finally(finish);
		} catch (err) {
			finish();
			throw err;
		}
	}

	private emitUIPromptEvent(event: UIPromptEvent): void {
		queueMicrotask(() => {
			void this.emit(event);
		});
	}
}
