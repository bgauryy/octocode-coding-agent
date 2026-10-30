import type { ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import { type FormEvent, useState } from "react";
import { useStore } from "zustand";
import { errorMessage } from "../model/format.ts";
import { Button } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";

type Awaiting = NonNullable<ApplicationSnapshot["awaiting"]>;

/**
 * The dialog a run is blocked on, answerable from the page: its options as buttons (an approval's are the host's own
 * words), and a text field where the dialog accepts text. The host takes the first answer, from here or the terminal.
 */
export function DialogAnswer({ awaiting, sessionId }: { awaiting: Awaiting; sessionId: string }) {
	const { session: sessionStore } = useLive();
	const connection = useStore(sessionStore, (state) => state.connection);
	const connected = useStore(sessionStore, (state) => state.connection?.connected ?? false);
	const [text, setText] = useState("");
	const [pending, setPending] = useState<string | undefined>(undefined);
	const [status, setStatus] = useState("");
	if (!awaiting.id || !connection) return null;
	const dialogId = awaiting.id;
	const send = async (answer: { choice: string } | { text: string }) => {
		if (pending) return;
		const key = "choice" in answer ? answer.choice : "text";
		setPending(key);
		setStatus("");
		try {
			const receipt = await connection.execute({
				id: crypto.randomUUID(),
				sessionId,
				action: "answer",
				dialogId,
				...answer,
			});
			if (receipt.status === "failed") setStatus(receipt.message ?? "The answer was not taken.");
		} catch (error) {
			setStatus(errorMessage(error));
		} finally {
			setPending(undefined);
		}
	};
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (text.trim()) void send({ text });
	};
	return (
		<section className="dialog-answer" aria-label="Answer the agent's question">
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
			{status ? <p className="muted dialog-answer-status">{status}</p> : null}
		</section>
	);
}
