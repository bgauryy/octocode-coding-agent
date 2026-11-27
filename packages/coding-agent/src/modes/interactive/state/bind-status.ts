/**
 * Mounts the status indicator the status slice describes: a new component when a new indicator is shown, in-place updates
 * (message, frames, compaction progress) while the same one stays, and the cleared row when it goes. Each change asks
 * for one frame here, so the writers only dispatch actions. Countdowns and spinners stay in the components: the clock
 * owns their cadence.
 */

import { shallowEqual, watchSelection } from "@octocodeai/octocode-tui";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	OfflineRetryStatusIndicator,
	RetryStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "../components/status-indicator.ts";
import { theme } from "../../../theme/theme.ts";
import { isEmbeddedStatus } from "../interactive-mode/helpers.ts";
import type { InteractiveModeHost } from "../interactive-mode/host.ts";
import { mountStatusIndicator, unmountStatusIndicator } from "../interactive-mode/status-indicators.ts";
import { DEFAULT_WORKING_MESSAGE, type ShownStatusIndicator, type StatusSlice } from "./status-slice.ts";

type BindStatusHost = Parameters<typeof mountStatusIndicator>[0] &
	Pick<InteractiveModeHost, "editor" | "session" | "ui" | "uiStore">;

type Drawn = [ShownStatusIndicator | undefined, StatusSlice["workingMessage"], StatusSlice["workingIndicator"]];

const drawn = ({ status }: { status: StatusSlice }): Drawn => [
	status.indicator,
	status.workingMessage,
	status.workingIndicator,
];

const workingText = (shown: ShownStatusIndicator & { kind: "working" }, message: string | undefined) =>
	shown.wait ?? message ?? DEFAULT_WORKING_MESSAGE;

/** An embedded indicator takes the editor's border colour, so it reads as part of the prompt. */
function borderColor(host: BindStatusHost): ((text: string) => string) | undefined {
	if (!isEmbeddedStatus(host.editor)) return undefined;
	return (text) => (host.editor.borderColor ?? theme.getThinkingBorderColor(host.session.thinkingLevel || "off"))(text);
}

function create(host: BindStatusHost, shown: ShownStatusIndicator, [, message, frames]: Drawn): StatusIndicator {
	switch (shown.kind) {
		case "working":
			return new WorkingStatusIndicator(host.ui, workingText(shown, message), frames, borderColor(host));
		case "compaction": {
			const indicator = new CompactionStatusIndicator(host.ui, shown.reason, borderColor(host));
			if (shown.progress) indicator.setProgress(shown.progress);
			return indicator;
		}
		case "retry":
			return shown.offline === undefined
				? new RetryStatusIndicator(host.ui, shown.attempt, shown.maxAttempts, shown.delayMs)
				: new OfflineRetryStatusIndicator(host.ui, shown.offline, shown.delayMs);
		case "branchSummary":
			return new BranchSummaryStatusIndicator(host.ui);
	}
}

/** Updates the mounted indicator in place for a change of the same shown indicator; false when nothing drawn changed. */
function update(indicator: StatusIndicator | undefined, next: Drawn, previous: Drawn): boolean {
	const [shown, message, frames] = next;
	const [before, previousMessage, previousFrames] = previous;
	if (!indicator) return false;
	if (shown?.kind === "working" && before?.kind === "working") {
		const text = workingText(shown, message);
		const changedText = text !== workingText(before, previousMessage);
		if (changedText) indicator.setMessage(text);
		if (frames !== previousFrames) indicator.setIndicator(frames);
		return changedText || frames !== previousFrames;
	}
	if (shown?.kind === "compaction" && before?.kind === "compaction" && shown.progress !== before.progress) {
		if (!(indicator instanceof CompactionStatusIndicator) || !shown.progress) return false;
		indicator.setProgress(shown.progress);
		return true;
	}
	return false;
}

/** Starts following the status slice; returns the function that stops it. */
export function bindStatusIndicator(host: BindStatusHost): () => void {
	return watchSelection(
		host.uiStore,
		drawn,
		(next, previous) => {
			const [shown] = next;
			const [before] = previous;
			if (!shown) {
				if (!before) return;
				unmountStatusIndicator(host);
			} else if (shown.seq !== before?.seq) {
				mountStatusIndicator(host, create(host, shown, next));
			} else if (!update(host.activeStatusIndicator, next, previous)) {
				return;
			}
			host.ui.requestRender();
		},
		shallowEqual,
	);
}
