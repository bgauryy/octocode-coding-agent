import type { Question, Reply } from "@octocodeai/octocode-contracts";
import { type SubmitEvent, useState } from "react";
import { Button } from "../ui/primitives.tsx";
import { AutoCountdown } from "./AutoCountdown.tsx";

interface Props {
	questions: Question[];
	disabled: boolean;
	loading: boolean;
	/** Whether the host's countdown still runs; the cards show it only then. */
	counting: boolean;
	/** One reply per question, picking options by id. */
	onSubmit: (replies: Reply[]) => void;
}

/**
 * A batch of typed questions as one form, answered with one reply per question id: a text question is a field, a
 * choice, confirmation or approval picks one option (a radio), a multi picks several (checkboxes), and a write-in or an
 * approval's deny-with-a-note option opens a text field. The host checks the replies against the questions again.
 */
export function QuestionsAnswer({ questions, disabled, loading, counting, onSubmit }: Props) {
	const [picks, setPicks] = useState<Record<string, string[]>>({});
	const [texts, setTexts] = useState<Record<string, string>>({});
	const pickedOf = (id: string) => picks[id] ?? [];
	const textOf = (id: string) => texts[id] ?? "";

	const toggle = (question: Question, optionId: string) =>
		setPicks((current) => {
			const held = current[question.id] ?? [];
			if (question.type !== "multi") return { ...current, [question.id]: [optionId] };
			return {
				...current,
				[question.id]: held.includes(optionId) ? held.filter((id) => id !== optionId) : [...held, optionId],
			};
		});
	/** The text field is shown for a text question, a write-in, and an approval option that takes a note. */
	const takesText = (question: Question): boolean =>
		question.type === "text" ||
		(question.writeIn !== undefined && question.writeIn !== false) ||
		(question.options ?? []).some((o) => o.role === "deny_note" && pickedOf(question.id).includes(o.id));
	const answered = (question: Question): boolean =>
		question.type === "text"
			? textOf(question.id).trim() !== ""
			: pickedOf(question.id).length > 0 || (question.writeIn !== undefined && textOf(question.id).trim() !== "");
	const replyTo = (question: Question): Reply => {
		const text = textOf(question.id).trim();
		return question.type === "text"
			? { id: question.id, picks: [], text }
			: { id: question.id, picks: pickedOf(question.id), ...(text && takesText(question) ? { text } : {}) };
	};
	const submit = (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (questions.every(answered)) onSubmit(questions.map(replyTo));
	};

	return (
		<form className="dialog-answer-questions" onSubmit={submit}>
			{questions.map((question) => (
				<fieldset key={question.id} className="dialog-answer-question" disabled={disabled || loading}>
					<legend>{question.header ? `${question.header}: ${question.question}` : question.question}</legend>
					{counting && question.timeoutSeconds && (question.options ?? []).some((option) => option.recommended) ? (
						<AutoCountdown
							seconds={question.timeoutSeconds}
							labels={(question.options ?? [])
								.filter((option) => option.recommended)
								.map((option) => option.label)
								.slice(0, question.type === "multi" ? undefined : 1)}
						/>
					) : null}
					{(question.options ?? []).map((option) => (
						<label key={option.id} className="dialog-answer-choice">
							<input
								type={question.type === "multi" ? "checkbox" : "radio"}
								name={question.id}
								checked={pickedOf(question.id).includes(option.id)}
								onChange={() => toggle(question, option.id)}
							/>
							<span className={option.tone === "danger" || option.role === "deny" ? "danger" : undefined}>
								{option.label}
								{option.recommended ? " ★" : ""}
							</span>
							{option.description ? (
								<span className="muted dialog-answer-description">{option.description}</span>
							) : null}
						</label>
					))}
					{takesText(question) ? (
						<input
							aria-label={question.writeIn ? question.writeIn.label : "Your answer"}
							value={textOf(question.id)}
							placeholder={
								question.writeIn ? (question.writeIn.placeholder ?? question.writeIn.label) : "Type your answer"
							}
							onChange={(event) => setTexts((current) => ({ ...current, [question.id]: event.target.value }))}
						/>
					) : null}
				</fieldset>
			))}
			<Button type="submit" loading={loading} disabled={disabled || loading || !questions.every(answered)}>
				Answer
			</Button>
		</form>
	);
}
