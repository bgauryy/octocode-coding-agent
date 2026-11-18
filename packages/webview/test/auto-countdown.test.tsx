/** @vitest-environment jsdom */
import type { Question } from "@octocodeai/octocode-contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuestionsAnswer } from "../src/app/live/QuestionsAnswer.tsx";

const question: Question = {
	id: "q1",
	type: "choice",
	question: "Continue to the next item?",
	timeoutSeconds: 20,
	options: [
		{ id: "1", label: "Continue (Recommended)", description: "The next item is routine", recommended: true },
		{ id: "2", label: "Stop", description: "Pause here" },
	],
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("counts down to the recommended option and shows each option's reason", () => {
	const view = render(
		<QuestionsAnswer questions={[question]} disabled={false} loading={false} counting onSubmit={() => undefined} />,
	);
	expect(screen.getByRole("timer").textContent).toBe("auto: Continue in 20s");
	expect(screen.getByText(/The next item is routine/)).toBeTruthy();
	expect(screen.getByText(/Pause here/)).toBeTruthy();
	act(() => void vi.advanceTimersByTime(2000));
	expect(screen.getByRole("timer").textContent).toBe("auto: Continue in 18s");
	view.unmount();
	expect(vi.getTimerCount()).toBe(0);
});

it("shows no countdown for a question without a timeout", () => {
	const { timeoutSeconds: _timeout, ...plain } = question;
	render(<QuestionsAnswer questions={[plain]} disabled={false} loading={false} counting onSubmit={() => undefined} />);
	expect(screen.queryByRole("timer")).toBeNull();
});

it("stops showing the countdown once the host's timer is held", () => {
	render(
		<QuestionsAnswer
			questions={[question]}
			disabled={false}
			loading={false}
			counting={false}
			onSubmit={() => undefined}
		/>,
	);
	expect(screen.queryByRole("timer")).toBeNull();
});
