import type { ProfileAgent, ProfileRequest, ProfileTimeline } from "@octocodeai/octocode-contracts";
import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { useStore } from "zustand";
import { IconButton } from "../../ui/primitives.tsx";
import { useLive } from "../session.tsx";
import { AgentDetail } from "./AgentDetail.tsx";
import { EventDetail, MessageDetail } from "./ItemDetail.tsx";
import type { ProfileSelection } from "./panel-props.ts";
import { RequestDetail } from "./RequestDetail.tsx";
import { useNow } from "./use-now.ts";

const DRAWER_MIN = 320;
const DRAWER_MAX = 560;

function titleOf(selection: ProfileSelection): string {
	switch (selection.kind) {
		case "agent":
			return selection.agentId;
		case "request":
			return `Request ${selection.index} · ${selection.agentId}`;
		case "event":
			return "Event";
		case "message":
			return `Message ${selection.id}`;
	}
}

function Missing({ children }: { children: string }) {
	return <p className="muted">{children}</p>;
}

/**
 * The one detail view every panel opens: a side panel on wide screens, a bottom sheet on narrow ones. It is a
 * complementary region, not a modal: the page behind stays usable. Esc closes it; the arrows beside the title step.
 */
export function Drawer({
	selection,
	agents,
	requests,
	timeline,
	width,
	onWidth,
	onSelect,
	onStep,
}: {
	selection: ProfileSelection;
	agents: readonly ProfileAgent[];
	requests: ReadonlyMap<string, readonly ProfileRequest[]>;
	timeline: ProfileTimeline | undefined;
	width: number;
	onWidth: (width: number) => void;
	onSelect: (selection: ProfileSelection | undefined) => void;
	onStep: (by: number) => void;
}) {
	const now = useNow();
	const team = useStore(useLive().workspace, (state) => state.snapshot?.agents);
	const traffic = useStore(useLive().workspace, (state) => state.snapshot?.traffic);
	const drag = useRef<{ x: number; width: number }>(undefined);
	const agentOf = (id: string) => agents.find((agent) => agent.id === id);
	const steps = selection.kind === "agent" || selection.kind === "request";

	function content() {
		if (selection.kind === "agent") {
			const agent = agentOf(selection.agentId);
			if (!agent) return <Missing>This agent is no longer listed.</Missing>;
			return (
				<AgentDetail
					agent={agent}
					requests={requests.get(agent.id) ?? []}
					member={team?.find((member) => member.id === agent.id)}
					traffic={traffic ?? []}
					now={now}
					onSelect={onSelect}
				/>
			);
		}
		if (selection.kind === "request") {
			const request = requests.get(selection.agentId)?.find((row) => row.index === selection.index);
			return request ? (
				<RequestDetail
					key={`${request.agentId}:${request.index}`}
					request={request}
					window={agentOf(request.agentId)?.contextWindow}
				/>
			) : (
				<Missing>{`Request ${selection.index} of ${selection.agentId} is still loading.`}</Missing>
			);
		}
		if (selection.kind === "event") {
			const id = selection.id;
			const event = timeline?.events.find((row) => row.id === id);
			return event ? (
				<EventDetail event={event} onSelect={onSelect} />
			) : (
				<Missing>This event is not in the trace.</Missing>
			);
		}
		const id = selection.id;
		const message = timeline?.messages.find((row) => row.id === id);
		return message ? <MessageDetail message={message} /> : <Missing>{`Message ${id} is not in the trace.`}</Missing>;
	}

	const clamp = (value: number) => Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, value));
	function onResizeKey(event: KeyboardEvent<HTMLButtonElement>) {
		const move = event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
		if (!move) return;
		event.preventDefault();
		onWidth(clamp(width + move));
	}
	function onResizeMove(event: PointerEvent<HTMLButtonElement>) {
		if (drag.current) onWidth(clamp(drag.current.width + drag.current.x - event.clientX));
	}

	return (
		// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc inside the drawer closes it; the controls within take focus
		<aside
			className="pf-drawer"
			aria-label={`Details: ${titleOf(selection)}`}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				event.stopPropagation();
				onSelect(undefined);
			}}
		>
			<button
				type="button"
				className="pf-resize"
				aria-label={`Resize details, ${width} pixels wide`}
				onKeyDown={onResizeKey}
				onPointerDown={(event) => {
					event.currentTarget.setPointerCapture(event.pointerId);
					drag.current = { x: event.clientX, width };
				}}
				onPointerMove={onResizeMove}
				onPointerUp={() => {
					drag.current = undefined;
				}}
			/>
			<header className="pf-drawer-head">
				<h3>{titleOf(selection)}</h3>
				{steps && (
					<>
						<IconButton label="Previous" icon={<span aria-hidden="true">↑</span>} onClick={() => onStep(-1)} />
						<IconButton label="Next" icon={<span aria-hidden="true">↓</span>} onClick={() => onStep(1)} />
					</>
				)}
				<IconButton
					label="Close details (Esc)"
					icon={<span aria-hidden="true">×</span>}
					onClick={() => onSelect(undefined)}
				/>
			</header>
			<div className="pf-drawer-body">{content()}</div>
		</aside>
	);
}
