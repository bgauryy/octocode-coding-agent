import type { UiState } from "@octocodeai/octocode-contracts";
import { cx } from "./primitives.tsx";

/**
 * The run-state shape, in the state's colour: ring (pending), turning arc (running), diamond (waiting), check (done),
 * cross (failed), square (stopped). Decorative: it always sits beside text that names the state.
 */
export function StateMark({ state, size = 14 }: { state: UiState; size?: number }) {
	return (
		<svg
			className={cx("state-mark", `mark-${state}`)}
			width={size}
			height={size}
			viewBox="0 0 14 14"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{state === "pending" ? (
				<circle cx="7" cy="7" r="5.25" />
			) : state === "running" ? (
				<>
					<circle cx="7" cy="7" r="5.25" opacity=".25" />
					<path className="mark-arc" d="M7 1.75A5.25 5.25 0 0 1 12.25 7" />
				</>
			) : state === "waiting" ? (
				<path d="M7 1.5 12.5 7 7 12.5 1.5 7Z" />
			) : state === "done" ? (
				<path d="m3 7.5 2.8 2.8L11.25 4" />
			) : state === "failed" ? (
				<path d="m3.5 3.5 7 7m0-7-7 7" />
			) : (
				<rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
			)}
		</svg>
	);
}
