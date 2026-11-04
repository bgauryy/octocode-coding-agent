import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { type SubmitEvent, useId, useState } from "react";
import { useStore } from "zustand";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Button } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";

type Awaiting = NonNullable<ApplicationSnapshot["awaiting"]>;

/**
 * The dialog a run is blocked on, answerable from the page: its options as buttons (an approval's are the host's own
 * words), and a text field where the dialog accepts text. The host takes the first answer, from here or the terminal.
 * The host accepts a command before the dialog's broker looks at it, so the page follows the command's receipt in the
 * session until it is completed or failed, and shows the refusal (already answered, not an offered choice) when it fails.
 */
export function DialogAnswer({ awaiting, sessionId }: { awaiting: Awaiting; sessionId: string }) {
	const { session: sessionStore } = useLive();
	const connection = useStore(sessionStore, (state) => state.connection);
	const connected = useStore(sessionStore, (state) => state.connection?.connected ?? false);
	const [text, setText] = useState("");
	const titleId = useId();
	// The answer in flight: its command id, and the button (or "text") that sent it.
	const [sent, setSent] = useState<{ id: string; key: string } | undefined>(undefined);
	const [status, setStatus] = useState("");
	const receipt = useStore(sessionStore, (state) =>
		sent ? state.application?.receipts.find((item) => item.id === sent.id) : undefined,
	);
	// The answer is in flight until its receipt is completed or failed; a failed one carries the broker's refusal.
	const settled = receipt?.status === "failed" || receipt?.status === "completed";
	const pending = sent && !settled ? sent.key : undefined;
	const refusal = receipt?.status === "failed" ? (receipt.message ?? "The answer was not taken.") : "";
	if (!awaiting.id || !connection) return null;
	const dialogId = awaiting.id;
	const send = async (answer: { choice: string } | { text: string }) => {
		if (pending) return;
		const id = crypto.randomUUID();
		setSent({ id, key: "choice" in answer ? answer.choice : "text" });
		setStatus("");
		try {
			const first = await connection.execute({
				id,
				sessionId,
				action: "answer",
				dialogId,
				...answer,
			});
			// An accepted receipt keeps the answer pending until the session's receipt for this command settles.
			if (first.status === "failed") {
				setStatus(first.message ?? "The answer was not taken.");
				setSent(undefined);
			}
		} catch (error) {
			setStatus(errorMessage(error));
			setSent(undefined);
		}
	};
	const submit = (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (text.trim()) void send({ text });
	};
	return (
		<section
			className="dialog-answer"
			aria-label={awaiting.title ? undefined : "Answer the agent's question"}
			aria-labelledby={awaiting.title ? titleId : undefined}
		>
			{awaiting.title ? (
				<p className="dialog-answer-title" id={titleId}>
					<span className="muted">{awaiting.kind === "approval" ? "Approval" : "Question"}</span> {awaiting.title}
				</p>
			) : null}
			{awaiting.options?.length ? (
				<div className="dialog-answer-options">
					{awaiting.options.map((option) => (
						<Button
							key={option}
							variant={awaiting.kind === "approval" && /deny|reject|no\b/i.test(option) ? "danger" : "primary"}
							loading={pending === option}
							disabled={!connected || pending !== undefined}
							onClick={() => void send({ choice: option })}
						>
							{option}
						</Button>
					))}
				</div>
			) : null}
			{awaiting.allowsText ? (
				<form className="dialog-answer-text" onSubmit={submit}>
					<input
						aria-label="Your answer"
						value={text}
						placeholder="Type your answer"
						disabled={!connected || pending !== undefined}
						onChange={(event) => setText(event.target.value)}
					/>
					<Button
						type="submit"
						loading={pending === "text"}
						disabled={!connected || pending !== undefined || !text.trim()}
					>
						Answer
					</Button>
				</form>
			) : null}
			{status || refusal ? <p className="muted dialog-answer-status">{status || refusal}</p> : null}
		</section>
	);
}
