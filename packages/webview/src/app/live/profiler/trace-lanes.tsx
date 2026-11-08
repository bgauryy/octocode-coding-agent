import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { memo, useState } from "react";
import type { Evidence } from "./insight-model.ts";
import type { ProfileSelection } from "./panel-props.ts";
import type { Arrow } from "./trace-arrows.ts";
import { describeArrow, describeItem } from "./trace-describe.ts";
import {
	cacheSegments,
	CONTEXT_H,
	type ContextPoint,
	type LaneItem,
	type LaneLayout,
	MARKER_H,
	RUN_BAR_H,
	RUN_ROW_H,
	TOOL_BAR_H,
	TOOL_ROW_H,
} from "./trace-model.ts";

const GLYPH: Record<string, string> = {
	interrupt: "\u27C2",
	steer: ">",
	notice: "i",
	compaction: "C",
	spawn: "+",
	exit: "x",
	permission: "?",
	message: "m",
};

/** The selection a click on this bar makes; a merged bar selects its first call. */
export function selectEvent(item: LaneItem): ProfileSelection {
	const { event } = item;
	if (event.kind === "request" && event.ref?.request !== undefined)
		return { kind: "request", agentId: event.agentId, index: event.ref.request };
	if (event.kind === "message" && event.ref?.message !== undefined) return { kind: "message", id: event.ref.message };
	return { kind: "event", id: item.group?.ids[0] ?? event.id };
}

export function isSelected(item: LaneItem, selection: ProfileSelection | undefined): boolean {
	if (!selection) return false;
	const chosen = selectEvent(item);
	if (chosen.kind !== selection.kind) return false;
	if (chosen.kind === "request" && selection.kind === "request")
		return chosen.agentId === selection.agentId && chosen.index === selection.index;
	if (chosen.kind === "message" && selection.kind === "message") return chosen.id === selection.id;
	return selection.kind === "event" && (item.group?.ids ?? [item.event.id]).includes(selection.id);
}

/** True when a finding's evidence points at this bar: highlighted in the Trace while the Insights panel is open. */
function isEvidence(item: LaneItem, evidence: readonly Evidence[] | undefined): boolean {
	if (!evidence?.length) return false;
	const { event } = item;
	const ids = item.group?.ids ?? [event.id];
	return evidence.some((row) =>
		row.request !== undefined
			? event.kind === "request" && event.agentId === row.agentId && event.ref?.request === row.request
			: row.event !== undefined && ids.includes(row.event),
	);
}

/** Cache-state fills, hatched waits and idle gaps: one definition per trace, classes carry the colours. */
export function Patterns({ id }: { id: string }) {
	return (
		<defs>
			<pattern id={`${id}-cached`} width="6" height="6" patternUnits="userSpaceOnUse">
				<rect className="pf-t-p-cached" width="6" height="6" />
			</pattern>
			<pattern id={`${id}-written`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
				<rect className="pf-t-p-written-bg" width="6" height="6" />
				<rect className="pf-t-p-written" width="3" height="6" />
			</pattern>
			<pattern id={`${id}-uncached`} width="5" height="5" patternUnits="userSpaceOnUse">
				<rect className="pf-t-p-uncached-bg" width="5" height="5" />
				<circle className="pf-t-p-uncached" cx="2.5" cy="2.5" r="1.3" />
			</pattern>
			<pattern id={`${id}-wait`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
				<rect className="pf-t-p-wait-bg" width="8" height="8" />
				<rect className="pf-t-p-wait" width="3" height="8" />
			</pattern>
			<pattern id={`${id}-idle`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
				<rect className="pf-t-p-idle-bg" width="8" height="8" />
				<rect className="pf-t-p-idle" width="1" height="8" />
			</pattern>
			<marker id={`${id}-head`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
				<path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
			</marker>
		</defs>
	);
}

interface ItemProps {
	item: LaneItem;
	laneGeo: LaneLayout["geo"];
	patternId: string;
	selected: boolean;
	evidence: boolean;
	tabbable: boolean;
	onActivate(): void;
}

function Marker({ item, laneGeo, ...rest }: ItemProps & { common: object }) {
	const cx = item.x;
	const cy = laneGeo.markerY + MARKER_H / 2;
	const glyph = GLYPH[item.event.kind] ?? "*";
	return (
		<g
			{...rest.common}
			data-kind={item.event.kind}
			className={`pf-t-marker${rest.selected || rest.evidence ? " is-on" : ""}`}
		>
			<title>{describeItem(item)}</title>
			<circle cx={cx} cy={cy} r={7} />
			<text x={cx} y={cy + 3.5} textAnchor="middle">
				{glyph}
			</text>
		</g>
	);
}

function Bar(props: ItemProps) {
	const { item, laneGeo, patternId, selected, evidence } = props;
	const { event } = item;
	const tool = item.track === "tool";
	const height = tool ? TOOL_BAR_H : RUN_BAR_H;
	const y = item.background
		? laneGeo.runY
		: tool
			? laneGeo.toolY + item.row * TOOL_ROW_H
			: laneGeo.runY + item.row * RUN_ROW_H;
	const h = item.background ? laneGeo.toolY - laneGeo.runY : height;
	const segments = cacheSegments(item);
	const fill = item.background
		? `url(#${patternId}-idle)`
		: event.kind === "wait" || event.kind === "permission"
			? `url(#${patternId}-wait)`
			: undefined;
	const outline = [
		"pf-t-outline",
		selected && "is-selected",
		evidence && "is-evidence",
		item.open && "is-open",
		event.outcome === "error" && "is-error",
		event.outcome === "aborted" && "is-aborted",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<>
			{item.background ? null : segments.length ? (
				segments.map((segment) => (
					<rect
						key={segment.state}
						x={segment.x}
						y={y}
						width={segment.width}
						height={h}
						fill={`url(#${patternId}-${segment.state})`}
					/>
				))
			) : (
				<rect
					className={fill ? undefined : `pf-t-kind pf-t-k-${event.kind}`}
					x={item.x}
					y={y}
					width={item.width}
					height={h}
					fill={fill}
				/>
			)}
			{item.background ? (
				<rect x={item.x} y={y} width={item.width} height={h} fill={fill} />
			) : (
				<rect className={outline} x={item.x} y={y} width={item.width} height={h} />
			)}
			{item.open ? <rect className="pf-t-edge" x={item.x + item.width - 3} y={y} width={3} height={h} /> : null}
			{item.breakAt !== undefined ? (
				<path className="pf-t-break" d={`M${item.x + item.breakAt - 4},${y - 1} h8 l-4,6 z`} aria-hidden="true" />
			) : null}
			{item.width > 56 && !item.background && !tool ? (
				<text className="pf-t-bartext" x={item.x + 5} y={y + h - 5} pointerEvents="none">
					{event.label.slice(0, Math.floor(item.width / 6.5))}
				</text>
			) : null}
		</>
	);
}

/** One bar or marker, a button for the keyboard and for assistive technology. */
function Item(props: ItemProps) {
	const [focused, setFocused] = useState(false);
	const { item, tabbable, selected, onActivate } = props;
	const common = {
		role: "button",
		"aria-label": describeItem(item),
		"aria-pressed": selected,
		tabIndex: tabbable ? 0 : -1,
		onKeyDown: (key: ReactKeyboardEvent) => {
			if (key.key === "Enter" || key.key === " ") {
				key.preventDefault();
				onActivate();
			}
		},
		onClick: onActivate,
		onFocus: () => setFocused(true),
		onBlur: () => setFocused(false),
	};
	if (!item.span) return <Marker {...props} selected={selected || focused} common={common} />;
	return (
		<g {...common} data-kind={item.event.kind} className={focused ? "pf-t-item is-focus" : "pf-t-item"}>
			<title>{describeItem(item)}</title>
			<Bar {...props} selected={selected || focused} />
		</g>
	);
}

interface LaneBarsProps {
	layout: LaneLayout;
	patternId: string;
	selection: ProfileSelection | undefined;
	evidence: readonly Evidence[] | undefined;
	tabbable: boolean;
	onSelect(selection: ProfileSelection): void;
}

/** All bars of one lane, idle gaps first so spans draw over them. Memoised: a hover or a tick elsewhere skips it. */
const LaneBars = memo(function LaneBars({ layout, patternId, selection, evidence, tabbable, onSelect }: LaneBarsProps) {
	const ordered = [...layout.items].sort((a, b) => Number(b.background) - Number(a.background));
	return (
		<>
			{ordered.map((item) => (
				<Item
					key={item.event.id}
					item={item}
					laneGeo={layout.geo}
					patternId={patternId}
					selected={isSelected(item, selection)}
					evidence={isEvidence(item, evidence)}
					tabbable={tabbable}
					onActivate={() => onSelect(selectEvent(item))}
				/>
			))}
		</>
	);
});

/** The context lane: tokens after each request as a stepped area against the window, with the compaction threshold. */
function ContextLane(props: {
	points: ContextPoint[];
	width: number;
	y: number;
	compactFraction?: number;
	label: string;
}) {
	const { points, width, y, compactFraction, label } = props;
	const inner = CONTEXT_H - 6;
	const base = y + CONTEXT_H - 3;
	const level = (fraction: number) => base - Math.min(1, fraction) * inner;
	let path = "";
	points.forEach((point, index) => {
		const x = Math.max(0, point.x);
		path += index === 0 ? `M${x},${base} L${x},${level(point.fraction)}` : ` H${x} V${level(point.fraction)}`;
	});
	const last = points.at(-1);
	if (last) path += ` H${width} V${base} Z`;
	return (
		// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an SVG group announced as one labelled image.
		<g role="img" aria-label={label} className="pf-t-ctx">
			<rect className="pf-t-ctx-track" x={0} y={y + 3} width={width} height={inner} />
			{path ? <path className="pf-t-ctx-area" d={path} /> : null}
			{compactFraction ? (
				<line className="pf-t-ctx-compact" x1={0} x2={width} y1={level(compactFraction)} y2={level(compactFraction)} />
			) : null}
		</g>
	);
}

export function ArrowLine(props: { arrow: Arrow; y1: number; y2: number; headId: string; selected: boolean }) {
	const { arrow, y1, y2, headId, selected } = props;
	const state = arrow.message.state;
	const pending = state === "queued" || state === "dead-lettered";
	return (
		<line
			className={`pf-t-arrow is-${state.replace(" ", "-")}${selected ? " is-selected" : ""}`}
			x1={arrow.x1}
			y1={y1}
			x2={arrow.x2}
			y2={y2}
			strokeDasharray={pending ? "5 3" : undefined}
			markerEnd={`url(#${headId})`}
			aria-label={describeArrow(arrow)}
			// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an SVG line announced as one labelled image.
			role="img"
			pointerEvents="none"
		>
			<title>{describeArrow(arrow)}</title>
		</line>
	);
}

interface LaneGroupProps extends LaneBarsProps {
	lane: { agentId: string; compactAt?: number; contextWindow?: number };
	top: number;
	alt: boolean;
	width: number;
	selected: boolean;
	/** Context points when the lane shows its context lane. */
	context: ContextPoint[] | undefined;
}

/** One agent's lane: background, bars and, when it has a window to draw against, the context lane. */
export function LaneGroup(props: LaneGroupProps) {
	const { lane, top, alt, width, selected, context, layout, ...bars } = props;
	return (
		// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- SVG has no semantic element for this role; it labels the lane for assistive technology.
		<g role="group" aria-label={`Lane ${lane.agentId}`} transform={`translate(0,${top})`}>
			<rect
				className={`pf-t-lane${alt ? " is-alt" : ""}${selected ? " is-selected" : ""}`}
				x={0}
				y={0}
				width={width}
				height={layout.geo.height}
			/>
			<LaneBars layout={layout} {...bars} />
			{context ? (
				<ContextLane
					points={context}
					width={width}
					y={layout.geo.contextY}
					compactFraction={lane.compactAt && lane.contextWindow ? lane.compactAt / lane.contextWindow : undefined}
					label={`Context of ${lane.agentId} per request`}
				/>
			) : null}
		</g>
	);
}
