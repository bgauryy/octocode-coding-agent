import { useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { answerNote, canAnswer, NEEDS_YOU_PANEL_ID, type NeedsYou, needsYouOf } from "../model/needs-you.ts";
import { DialogAnswer } from "./DialogAnswer.tsx";
import { useLive } from "./session.tsx";

/** The session's open dialog as "needs you", for the header pill, the tab title and the palette. */
export function useNeedsYou(): NeedsYou | undefined {
	const { awaiting, sessionId, capabilities } = useStore(
		useLive().session,
		useShallow((state) => ({
			awaiting: state.application?.awaiting,
			sessionId: state.application?.sessionId,
			capabilities: state.application?.capabilities,
		})),
	);
	return useMemo(
		() => (sessionId && capabilities ? needsYouOf({ awaiting, sessionId, capabilities }) : undefined),
		[awaiting, sessionId, capabilities],
	);
}

/** The note about where approvals are answered, from the same capability the composer uses to offer the dialog. */
export function useAnswerNote(): string | undefined {
	const capabilities = useStore(useLive().session, (state) => state.application?.capabilities);
	return capabilities ? answerNote(canAnswer({ capabilities })) : undefined;
}

/** The waiting dialog inline under the header, reachable from any view; Escape closes it. */
export function NeedsYouAnswer({ needs, onClose }: { needs: NeedsYou; onClose: () => void }) {
	const panel = useRef<HTMLElement>(null);
	const dialogId = needs.awaiting.id;
	useEffect(() => {
		panel.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
	}, [dialogId]);
	// Escape closes the panel when focus is inside it, without a modal's focus trap.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented && panel.current?.contains(document.activeElement))
				onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);
	return (
		<section ref={panel} id={NEEDS_YOU_PANEL_ID} className="needs-you-panel" aria-label="Needs you">
			{needs.answerable ? (
				<DialogAnswer key={dialogId} awaiting={needs.awaiting} sessionId={needs.sessionId} />
			) : (
				<p>
					<strong>{needs.title}</strong> <span className="muted">Answer it in the terminal.</span>
				</p>
			)}
		</section>
	);
}
