import type { ProfileEvent, ProfileMessage } from "@octocodeai/octocode-contracts";
import { span, stamp } from "../../model/format.ts";
import { Badge, Button } from "../../ui/primitives.tsx";
import { formatTokens } from "../profiler-model.ts";
import { messageRoute, routeText } from "./message-model.ts";
import { MessageTranscript } from "./MessageTranscript.tsx";
import { RouteCell } from "./MessageRouteCell.tsx";
import type { ProfileSelection } from "./panel-props.ts";

function Fact({ name, value }: { name: string; value: string }) {
	return (
		<div>
			<dt>{name}</dt>
			<dd>{value}</dd>
		</div>
	);
}

const PHASE_NAMES: Record<string, string> = {
	firstToken: "First token",
	stream: "Streaming",
	prepare: "Preparation",
	queued: "Queued",
	finalize: "Finalization",
	held: "Result held",
};

/** A trace event in the drawer: what, when, how long and where the time went, with how it ended and a way to its request. */
export function EventDetail({
	event,
	onSelect,
}: {
	event: ProfileEvent;
	onSelect: (selection: ProfileSelection) => void;
}) {
	const request = event.ref?.request;
	return (
		<div className="pf-detail" aria-label={`Event ${event.kind}`} style={{ display: "grid", gap: 12 }}>
			<p style={{ margin: 0, overflowWrap: "anywhere" }}>{event.label}</p>
			<dl className="pf-facts">
				<Fact name="Agent" value={event.agentId} />
				<Fact name="Kind" value={event.kind} />
				<Fact name="Started" value={stamp(event.at)} />
				{event.durationMs !== undefined && <Fact name="Duration" value={span(event.durationMs)} />}
				{event.peer && <Fact name={event.direction === "received" ? "From" : "With"} value={event.peer} />}
				{event.tokens !== undefined && <Fact name="Tokens" value={formatTokens(event.tokens)} />}
				{Object.entries(event.phases ?? {}).map(([phase, ms]) =>
					phase === "execute" || ms === undefined ? null : (
						<Fact key={phase} name={PHASE_NAMES[phase] ?? phase} value={span(ms)} />
					),
				)}
				{event.early && <Fact name="Started" value="while the model streamed" />}
			</dl>
			{event.outcome && <Badge tone={event.outcome === "ok" ? "success" : "danger"}>{event.outcome}</Badge>}
			{request !== undefined && (
				<div className="pf-actions">
					<Button size="sm" onClick={() => onSelect({ kind: "request", agentId: event.agentId, index: request })}>
						Open request {request}
					</Button>
				</div>
			)}
		</div>
	);
}

/** A message in the drawer: who to whom with their marks, its delivery lifecycle, its text and what the sender thought and wrote near the send. */
export function MessageDetail({ message }: { message: ProfileMessage }) {
	const route = messageRoute(message);
	return (
		<div className="pf-detail" aria-label={`Message ${message.id}`} style={{ display: "grid", gap: 12 }}>
			<p className="pf-detail-route" aria-label={routeText(route)}>
				<RouteCell route={route} />
			</p>
			<dl className="pf-facts">
				<Fact name="From" value={message.from} />
				<Fact name="To" value={message.to.join(", ")} />
				{message.internal && <Fact name="Internal notice" value={message.label ?? "notice"} />}
				<Fact name="State" value={message.state} />
				<Fact name="Sent" value={stamp(message.at)} />
				{message.deliveredMs !== undefined && <Fact name="Delivered after" value={span(message.deliveredMs)} />}
				{message.answeredMs !== undefined && <Fact name="Answered after" value={span(message.answeredMs)} />}
			</dl>
			<p className="pf-detail-text">{message.text ?? message.preview}</p>
			{message.transcript ? (
				<MessageTranscript
					key={`${message.transcript.agentId}:${message.transcript.sessionId ?? ""}:${message.transcript.entry}`}
					transcript={message.transcript}
				/>
			) : null}
		</div>
	);
}
