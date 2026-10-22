import { type Component, Container, type TUI } from "@octocodeai/octocode-tui";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";

type TranscriptRoot = Pick<TUI, "children" | "requestRender">;

export class ThinkingTranscript {
	private hidden = false;
	private readonly seen = new WeakSet<AssistantMessageComponent>();

	private readonly root: TranscriptRoot;
	constructor(root: TranscriptRoot) {
		this.root = root;
	}

	refresh(): void {
		this.visit(this.root.children, false);
	}

	toggle(): void {
		this.hidden = !this.hidden;
		this.visit(this.root.children, true);
		this.root.requestRender();
	}

	private visit(children: Component[], force: boolean): void {
		for (const child of children) {
			if (child instanceof AssistantMessageComponent) {
				if (force || !this.seen.has(child)) {
					child.setHideThinkingBlock(this.hidden);
					this.seen.add(child);
				}
			} else if (child instanceof Container) {
				this.visit(child.children, force);
			}
		}
	}
}

const transcripts = new WeakMap<TranscriptRoot, ThinkingTranscript>();

export function thinkingTranscript(root: TranscriptRoot): ThinkingTranscript {
	let transcript = transcripts.get(root);
	if (!transcript) {
		transcript = new ThinkingTranscript(root);
		transcripts.set(root, transcript);
	}
	return transcript;
}
