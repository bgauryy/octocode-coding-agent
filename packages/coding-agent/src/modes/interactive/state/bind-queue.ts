/**
 * Binds the pending-messages area to the queues. The run status and the moment to look again come from the
 * application service's read-only state source, the session's steering and follow-up queues from the session (the
 * service state keeps only previews of them); the messages the interface holds itself (compaction,
 * session switch) come from the UI store. Writers only change a queue: each real change redraws the area once, and a
 * write that changes nothing draws nothing.
 */

import { Spacer, TruncatedText, watchSelection } from "@octocodeai/octocode-tui";
import type { ApplicationStateSource } from "../../../core/application/state.ts";
import { theme } from "../../../theme/theme.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import type { InteractiveModeHost } from "../interactive-mode/host.ts";
import { refreshQueueList } from "../interactive-mode/queue-list.ts";
import { selectHeldMessages } from "./queue-slice.ts";

type BindQueueHost = Pick<
	InteractiveModeHost,
	"getAppKeyDisplay" | "pendingMessagesContainer" | "session" | "ui" | "uiStore"
>;

export interface QueueView {
	steering: readonly string[];
	followUp: readonly string[];
	compacting: boolean;
	/** Held messages carried over a session switch: they wait for Enter in an empty editor. */
	carried: number;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameView = (a: QueueView, b: QueueView) =>
	a.compacting === b.compacting &&
	a.carried === b.carried &&
	sameList(a.steering, b.steering) &&
	sameList(a.followUp, b.followUp);

/**
 * Every queued message the user sees: the session's queues, then those the interface holds, by kind. The service state
 * carries only the last ten previews of each queue, so it says when to look again and whether compaction runs; the
 * session has the whole queues, and the count and the first messages shown must be theirs.
 */
function selectQueueView(host: Pick<BindQueueHost, "session" | "uiStore">, service: ApplicationStateSource): QueueView {
	const held = selectHeldMessages(host.uiStore.getState());
	return {
		steering: [...host.session.getSteeringMessages(), ...held.filter((m) => m.mode === "steer").map((m) => m.text)],
		followUp: [...host.session.getFollowUpMessages(), ...held.filter((m) => m.mode === "followUp").map((m) => m.text)],
		compacting: service.getState().status === "compacting",
		carried: held.filter((m) => m.carried).length,
	};
}

function oneLine(text: string): string {
	return stripAnsi(text)
		.replace(/[\r\n\t\u2028\u2029]+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Rebuilds the area: a summary, the first three messages, a hint. Nothing queued leaves it empty. */
export function renderPendingMessages(host: BindQueueHost, view: QueueView): void {
	const area = host.pendingMessagesContainer;
	area.clear();
	const total = view.steering.length + view.followUp.length;
	if (total === 0) return;
	area.addChild(new Spacer(1));
	area.addChild(
		new TruncatedText(
			theme.fg("accent", `${total} queued · ${view.steering.length} next turn · ${view.followUp.length} after run`),
			1,
			0,
		),
	);
	const previews = [
		...view.steering.map((text) => ({ label: "Next turn", text })),
		...view.followUp.map((text) => ({ label: "After run", text })),
	];
	for (const [index, message] of previews.slice(0, 3).entries()) {
		const line = `${theme.fg("muted", `${index + 1}. ${message.label}: `)}${theme.fg("text", oneLine(message.text))}`;
		area.addChild(new TruncatedText(line, 1, 0));
	}
	if (total > 3) area.addChild(new TruncatedText(theme.fg("muted", `… ${total - 3} more queued`), 1, 0));
	const dequeueHint = host.getAppKeyDisplay("app.message.dequeue");
	const send = view.carried > 0 && !view.compacting ? "Enter sends · " : "";
	const hint = `↳ ${send}↑ to manage · ${dequeueHint} restores the last · Esc restores all${view.compacting ? " · waiting for compaction" : ""}`;
	area.addChild(new TruncatedText(theme.fg("muted", hint), 1, 0));
}

/** Starts following the queues of `service`; returns the function that stops it. */
export function bindQueueState(host: BindQueueHost, service: ApplicationStateSource): () => void {
	const view = () => selectQueueView(host, service);
	const redraw = () => {
		renderPendingMessages(host, view());
		refreshQueueList(host);
		host.ui.requestRender();
	};
	// Drawn once now, so a queue that already holds messages (a rebound session) shows before its next change.
	renderPendingMessages(host, view());
	const stops = [
		// Any service change may be a queue change; `sameView` leaves the area alone when the queues did not change.
		watchSelection(service, view, redraw, sameView),
		watchSelection(host.uiStore, selectHeldMessages, redraw),
	];
	return () => {
		for (const stop of stops) stop();
	};
}
