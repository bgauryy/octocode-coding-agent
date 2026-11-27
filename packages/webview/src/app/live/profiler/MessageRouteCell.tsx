import { MESSAGE_STATES, endLabel, type MessageRoute, type RouteEnd } from "./message-model.ts";
import type { TrafficState } from "@octocodeai/octocode-contracts";

/** One end of a message: name and role, then worktree, branch and tmux marks, `departed` and (with several recipients) its delivery state. */
function End({ end, state }: { end: RouteEnd; state?: TrafficState }) {
	return (
		<span className={`pf-end${end.departed ? " is-departed" : ""}`}>
			<span className="pf-end-name">{endLabel(end)}</span>
			{end.marks.map((mark) => (
				<span key={mark} className="pf-mark">
					{mark}
				</span>
			))}
			{end.departed ? <span className="pf-mark is-departed">departed</span> : null}
			{state ? <span className={`pf-mark is-${MESSAGE_STATES[state].tone}`}>{state}</span> : null}
		</span>
	);
}

/** `sender(role) → recipient(role)` with every end's marks. */
export function RouteCell({ route }: { route: MessageRoute }) {
	return (
		<>
			<End end={route.from} />
			<span aria-hidden="true">{" \u2192 "}</span>
			{route.to.map((end, position) => (
				<span key={end.id}>
					{position ? ", " : ""}
					<End end={end} {...(end.state ? { state: end.state } : {})} />
				</span>
			))}
		</>
	);
}
