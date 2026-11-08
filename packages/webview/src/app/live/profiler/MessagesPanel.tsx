import type { ProfileMessage } from "@octocodeai/octocode-contracts";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { stamp } from "../../model/format.ts";
import {
	filterMessages,
	flowLabel,
	flowPairs,
	groupThreads,
	latencyText,
	MESSAGE_STATES,
	type PairKey,
} from "./message-model.ts";
import type { PanelProps } from "./panel-props.ts";
import { formatLatency, formatOffset } from "./trace-format.ts";
import { sessionBounds } from "./trace-view.ts";
import { formatClock, useNow } from "./use-now.ts";

function StatePill({ state }: { state: ProfileMessage["state"] }) {
	const { symbol, tone } = MESSAGE_STATES[state];
	return (
		<span className={`pf-pill is-${tone}`}>
			<span aria-hidden="true">{symbol}</span> {state}
		</span>
	);
}

/** Time since the message was sent, ticking; only this node re-renders each second. */
function Waiting({ since }: { since: number }) {
	return <span className="pf-m-wait">waiting {formatClock(useNow() - since)}</span>;
}

/**
 * Messages between agents: a strip of per-pair counts to filter by, then one row per message with a state pill,
 * delivery and answer latencies and, for an unanswered one, the time it has waited. Selecting a row opens the drawer.
 */
export function MessagesPanel({ timeline, selection, onSelect, range, filter }: PanelProps) {
	const messages = timeline?.messages;
	const origin = useMemo(
		() => sessionBounds(timeline?.events ?? [], messages ?? [])?.from ?? 0,
		[timeline?.events, messages],
	);
	const agentId = selection?.kind === "agent" ? selection.agentId : undefined;
	const [pair, setPair] = useState<PairKey>();
	const pairs = useMemo(() => flowPairs(messages ?? []), [messages]);
	const rows = useMemo(
		() => groupThreads(filterMessages(messages ?? [], { filter, range, agentId, pair })),
		[messages, filter, range, agentId, pair],
	);
	const [focused, setFocused] = useState<number>();
	const body = useRef<HTMLTableSectionElement>(null);

	if (!timeline) {
		return (
			<section className="pf-empty-block" aria-label="Messages">
				<p className="muted">Loading messages{"\u2026"}</p>
			</section>
		);
	}
	if (!rows.length) {
		return (
			<section className="pf-empty-block" aria-label="Messages">
				<p className="muted">
					{timeline.messages.length
						? "No messages match the filter, range or agent."
						: "No messages between agents yet."}
				</p>
				{pair ? (
					<button type="button" className="pf-t-btn" onClick={() => setPair(undefined)}>
						Show all pairs
					</button>
				) : null}
			</section>
		);
	}

	const select = (id: number) => onSelect({ kind: "message", id });
	const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, id: number) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			select(id);
			return;
		}
		const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		const siblings = body.current?.querySelectorAll<HTMLElement>("tr[data-message]");
		const at = Array.from(siblings ?? []).indexOf(event.currentTarget);
		siblings?.[Math.min(Math.max(at + step, 0), siblings.length - 1)]?.focus();
	};
	const selectedId = selection?.kind === "message" ? selection.id : undefined;
	const tabbable = rows.some((row) => row.message.id === selectedId) ? selectedId : rows[0]?.message.id;

	return (
		<section className="pf-messages" aria-label="Messages">
			{pairs.length ? (
				<ul className="pf-m-flow" aria-label="Messages per agent pair">
					{pairs.map((item) => {
						const on = pair?.from === item.from && pair.to === item.to;
						return (
							<li key={`${item.from}>${item.to}`}>
								<button
									type="button"
									className={`pf-m-pair${item.awaiting || item.deadLettered ? " has-issue" : ""}`}
									aria-pressed={on}
									onClick={() => setPair(on ? undefined : { from: item.from, to: item.to })}
								>
									{flowLabel(item)}
								</button>
							</li>
						);
					})}
				</ul>
			) : null}
			<p className="pf-m-count muted">
				{rows.length} {rows.length === 1 ? "message" : "messages"}
				{agentId ? ` of ${agentId}` : ""}
			</p>
			<div className="pf-m-scroll">
				<table className="pf-m-table" aria-label="Messages between agents">
					<thead>
						<tr>
							<th>Time</th>
							<th>From {"\u2192"} to</th>
							<th>State</th>
							<th className="pf-m-text-head">Message</th>
							<th>Latency</th>
						</tr>
					</thead>
					<tbody ref={body}>
						{rows.map(({ message, depth }) => {
							const selected = message.id === selectedId;
							const route = `${message.from} \u2192 ${message.to.join(", ")}`;
							return (
								<tr
									key={message.id}
									data-message={message.id}
									className={`${selected ? "is-selected" : ""}${focused === message.id ? " is-focus" : ""}`}
									tabIndex={message.id === tabbable ? 0 : -1}
									aria-selected={selected}
									aria-level={depth + 1}
									aria-label={`message ${message.id}, ${route}, ${message.state}, delivered ${formatLatency(message.deliveredMs)}, answered ${formatLatency(message.answeredMs)}`}
									onClick={() => select(message.id)}
									onKeyDown={(event) => onKeyDown(event, message.id)}
									onFocus={() => setFocused(message.id)}
									onBlur={() => setFocused(undefined)}
								>
									<td className="pf-m-time">
										<time dateTime={new Date(message.at).toISOString()} title={stamp(message.at)}>
											{formatOffset(message.at, origin)}
										</time>
									</td>
									<td className="pf-m-route">{route}</td>
									<td>
										<StatePill state={message.state} />
										{message.state === "awaiting reply" ? <Waiting since={message.at} /> : null}
									</td>
									<td className="pf-m-text" style={{ paddingInlineStart: 8 + depth * 18 }}>
										{depth > 0 ? <span aria-hidden="true">{"\u21B3 "}</span> : null}
										{selected && message.text ? (
											<pre aria-label={`Full text of message ${message.id}`}>{message.text}</pre>
										) : (
											message.preview
										)}
									</td>
									<td className="pf-m-latency">{latencyText(message)}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}
