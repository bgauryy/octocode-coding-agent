import {
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { PanelProps, ProfileRange } from "./panel-props.ts";
import type { Evidence } from "./insight-model.ts";
import { selectEvent, ArrowLine, isSelected, LaneGroup, Patterns } from "./trace-lanes.tsx";
import { FilterChips, TraceLegend, TraceTable, TraceTooltip, ViewButtons } from "./trace-controls.tsx";
import { describeArrow, tooltipLines } from "./trace-describe.ts";
import { filterTrace, type KindChip } from "./trace-filter.ts";
import { formatDuration, formatOffset } from "./trace-format.ts";
import { LaneLabel } from "./trace-gutter.tsx";
import { hitArrow, layoutArrows } from "./trace-arrows.ts";
import { Minimap } from "./trace-minimap.tsx";
import {
	buildLanes,
	contextSeries,
	eventsByAgent,
	hitItem,
	type Lane,
	type LaneItem,
	layoutLane,
	openActivityEvent,
	requestLookup,
	RUN_BAR_H,
} from "./trace-model.ts";
import { rulerTicks, sessionBounds, timeToX, type Viewport, xToTime } from "./trace-view.ts";
import { useNow } from "./use-now.ts";
import { useTraceView } from "./use-trace-view.ts";
import { useTraceWheel } from "./use-trace-wheel.ts";
import { useWidth } from "./use-width.ts";

export interface TracePanelProps extends PanelProps {
	/** Evidence rows of the finding being looked at in Insights: their bars get a ring. */
	evidence?: readonly Evidence[];
}

const RULER_H = 26;
const GUTTER_W = 220;
const NARROW_GUTTER_W = 96;
const NARROW_BELOW = 760;
const TABBABLE_LIMIT = 300;

interface Hover {
	x: number;
	y: number;
	lines: string[];
}

/**
 * The waterfall: an agent tree beside time lanes, request bars split by cache state, tool bars beneath, a context
 * lane, live "now" and growing open bars, message arrows, a minimap to brush, and zoom, pan and keys. Selecting
 * anything hands it to the shared drawer; this panel draws no detail itself.
 */
export function TracePanel({
	agents,
	requests,
	timeline,
	selection,
	onSelect,
	range,
	onRange,
	filter,
	evidence,
}: TracePanelProps) {
	const id = useId().replace(/:/g, "");
	const [hostRef, hostWidth] = useWidth();
	const plotRef = useRef<HTMLDivElement>(null);
	const narrow = hostWidth < NARROW_BELOW;
	const gutterW = narrow ? NARROW_GUTTER_W : GUTTER_W;
	const plotW = Math.max(120, hostWidth - gutterW - 2);
	const now = useNow();
	const events = timeline?.events;
	const messages = timeline?.messages;

	const [pinned, setPinned] = useState<string[]>([]);
	const [collapsed, setCollapsed] = useState<string[]>([]);
	const [grouped, setGrouped] = useState(false);
	const [problemsOnly, setProblemsOnly] = useState(false);
	const [hidden, setHidden] = useState<ReadonlySet<KindChip>>(new Set());
	const [hover, setHover] = useState<Hover>();

	const lanes = useMemo(() => {
		const all = buildLanes(agents);
		return [
			...all.filter((lane) => pinned.includes(lane.agentId)),
			...all.filter((lane) => !pinned.includes(lane.agentId)),
		];
	}, [agents, pinned]);
	const live = lanes.some((lane) => lane.status === "working" && lane.activity);
	const clock = live ? now : undefined;
	const tick = clock ?? 0;
	const bounds = useMemo(() => sessionBounds(events ?? [], messages ?? [], clock), [events, messages, clock]);
	const { current, following, zoom, pan, fitTo, tail, live: goLive, reset } = useTraceView(bounds, range, onRange);
	const viewFrom = current?.from;
	const viewTo = current?.to;
	const viewport: Viewport | undefined = current && { ...current, width: plotW };

	const lookup = useMemo(() => requestLookup(requests), [requests]);
	const visible = useMemo(
		() => filterTrace(events ?? [], { text: filter, problemsOnly, hidden }, lookup),
		[events, filter, problemsOnly, hidden, lookup],
	);
	const byAgent = useMemo(() => eventsByAgent(visible), [visible]);
	const selectedAgent = selection?.kind === "agent" ? selection.agentId : undefined;
	const showsContext = (lane: Lane) =>
		Boolean(lane.contextWindow) && !collapsed.includes(lane.agentId) && (!narrow || selectedAgent === lane.agentId);
	const layouts = useMemo(
		() =>
			viewport
				? lanes.map((lane) =>
						layoutLane(byAgent.get(lane.agentId) ?? [], viewport, lookup, {
							group: grouped,
							open: openActivityEvent({ id: lane.agentId, status: lane.status, activity: lane.activity }, now),
							contextLane: showsContext(lane),
						}),
					)
				: [],
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- viewport derives from current and plotW; showsContext from collapsed, narrow and selectedAgent
		[lanes, byAgent, lookup, viewFrom, viewTo, plotW, grouped, collapsed, narrow, selectedAgent, tick],
	);
	const arrows = useMemo(
		() => (viewport && !hidden.has("messages") ? layoutArrows(messages ?? [], lanes, viewport) : []),
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- viewport derives from current and plotW
		[messages, lanes, hidden, viewFrom, viewTo, plotW],
	);
	const tops: number[] = [];
	let total = RULER_H;
	for (const layout of layouts) {
		tops.push(total);
		total += layout.geo.height;
	}
	const laneY = (lane: number) => (tops[lane] ?? RULER_H) + (layouts[lane]?.geo.runY ?? 0) + RUN_BAR_H / 2;

	useTraceWheel(hostRef, plotRef, { zoom, pan, current, plotW });

	if (!bounds || !viewport || !current) {
		return (
			<section className="pf-empty-block" aria-label="Trace">
				<p className="muted">{timeline ? "No events recorded yet." : "Loading the trace\u2026"}</p>
			</section>
		);
	}

	const items = layouts.flatMap((layout, lane) =>
		layout.items.filter((item) => !item.background).map((item) => ({ item, lane })),
	);
	const itemsOf = (lane: number): LaneItem[] =>
		(layouts[lane]?.items ?? []).filter((item) => !item.background).sort((a, b) => a.event.at - b.event.at);
	const selectedAt = items.find(({ item }) => isSelected(item, selection));
	const stepLane = (step: number) => {
		const lane =
			selectedAt?.lane ??
			Math.max(
				0,
				lanes.findIndex((row) => row.agentId === selectedAgent),
			);
		const list = itemsOf(lane);
		const at = selectedAt ? list.indexOf(selectedAt.item) : -1;
		const next = list[Math.min(Math.max(at + step, 0), list.length - 1)];
		if (next) onSelect(selectEvent(next));
	};
	const onKeyDown = (event: ReactKeyboardEvent) => {
		if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey) return;
		const key = event.key.toLowerCase();
		const handled = ((): boolean => {
			switch (key) {
				case "+":
				case "=":
					zoom(0.6);
					return true;
				case "-":
					zoom(1 / 0.6);
					return true;
				case "arrowleft":
					pan(-0.2);
					return true;
				case "arrowright":
					pan(0.2);
					return true;
				case "escape":
					reset();
					return true;
				case "f": {
					const picked = selectedAt?.item.event;
					fitTo(picked ? { from: picked.at, to: picked.at + (picked.durationMs ?? 0) } : undefined);
					return true;
				}
				case "g":
					setGrouped((value) => !value);
					return true;
				case "[":
					stepLane(-1);
					return true;
				case "]":
					stepLane(1);
					return true;
				default:
					return false;
			}
		})();
		if (handled) event.preventDefault();
	};

	const local = (event: { clientX: number; clientY: number; currentTarget: Element }) => {
		const box = (event.currentTarget.closest("svg") ?? event.currentTarget).getBoundingClientRect();
		return { x: event.clientX - box.left, y: event.clientY - box.top };
	};
	const pick = (x: number, y: number) => {
		const lane = tops.findLastIndex((top) => y >= top);
		const layout = layouts[lane];
		return layout && lane >= 0 ? hitItem(layout, x, y - (tops[lane] ?? 0)) : undefined;
	};
	const onPlotClick = (event: ReactMouseEvent<SVGGElement>) => {
		if ((event.target as Element).closest('[role="button"]')) return;
		const { x, y } = local(event);
		const item = pick(x, y);
		if (item) return onSelect(selectEvent(item));
		const arrow = hitArrow(arrows, x, y, laneY);
		if (arrow) onSelect({ kind: "message", id: arrow.message.id });
	};
	const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
		const { x, y } = local(event);
		if (x < 0 || x > plotW || y < RULER_H) return setHover(undefined);
		const item = pick(x, y);
		const arrow = item ? undefined : hitArrow(arrows, x, y, laneY);
		const what = item ? tooltipLines(item) : arrow ? [describeArrow(arrow)] : [];
		setHover({ x, y, lines: [...what, formatOffset(xToTime(x, viewport), bounds.from)] });
	};

	const nowX = live ? timeToX(now, viewport) : undefined;
	const banner = `${formatOffset(current.from, bounds.from)} to ${formatOffset(current.to, bounds.from)}, ${formatDuration(current.to - current.from)} shown`;
	const tabbable = items.length <= TABBABLE_LIMIT;
	const toggleIn = (list: string[], value: string) =>
		list.includes(value) ? list.filter((row) => row !== value) : [...list, value];

	return (
		// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- keys on the focused trace zoom, pan and step; the bars are the buttons.
		<section
			ref={hostRef}
			className="pf-trace"
			aria-label="Trace"
			// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the trace is the keyboard stop for zoom, pan and step.
			tabIndex={0}
			onKeyDown={onKeyDown}
		>
			<div className="pf-t-bar">
				<p className="pf-t-banner">
					<span>{banner}</span>
					<span className="pf-t-hint">
						Ctrl+wheel or +/- zoom · Shift+wheel or arrows pan · F fit · [ ] step · G group · Esc reset
					</span>
				</p>
				<ViewButtons
					live={live}
					following={following}
					grouped={grouped}
					onTail={tail}
					onFit={reset}
					onLive={goLive}
					onGroup={() => setGrouped((value) => !value)}
				/>
			</div>
			<div className="pf-t-mini" style={{ paddingInlineStart: gutterW }}>
				<Minimap
					events={visible}
					bounds={bounds}
					view={current}
					width={plotW}
					height={narrow ? 36 : 48}
					laneCount={lanes.length}
					onBrush={(next: ProfileRange) => onRange(next)}
				/>
			</div>
			<FilterChips
				problemsOnly={problemsOnly}
				hidden={hidden}
				onProblems={() => setProblemsOnly((value) => !value)}
				onToggle={(chip) =>
					setHidden((value) => {
						const next = new Set(value);
						if (!next.delete(chip)) next.add(chip);
						return next;
					})
				}
			/>
			<div className="pf-t-body" style={{ gridTemplateColumns: `${gutterW}px minmax(0, 1fr)` }}>
				<div className="pf-t-gutter">
					<div style={{ height: RULER_H }} className="pf-t-gutter-head">
						Agents
					</div>
					{lanes.map((lane, index) => (
						<LaneLabel
							key={lane.agentId}
							lane={lane}
							height={layouts[index]?.geo.height ?? 0}
							selected={selectedAgent === lane.agentId}
							pinned={pinned.includes(lane.agentId)}
							expanded={lane.contextWindow ? showsContext(lane) : undefined}
							narrow={narrow}
							onSelect={() => onSelect({ kind: "agent", agentId: lane.agentId })}
							onPin={() => setPinned((list) => toggleIn(list, lane.agentId))}
							onExpand={() => setCollapsed((list) => toggleIn(list, lane.agentId))}
						/>
					))}
				</div>
				<div className="pf-t-plot" ref={plotRef}>
					<svg
						width={plotW}
						height={total}
						// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- SVG has no semantic element for this role; it labels the lanes for assistive technology.
						role="group"
						aria-label="Agent lanes"
						onPointerMove={onMove}
						onPointerLeave={() => setHover(undefined)}
					>
						<Patterns id={id} />
						{rulerTicks(current).map((tick) => (
							<g key={tick} pointerEvents="none">
								<line
									className="pf-t-grid"
									x1={timeToX(tick, viewport)}
									x2={timeToX(tick, viewport)}
									y1={RULER_H - 6}
									y2={total}
								/>
								<text className="pf-t-tick" x={timeToX(tick, viewport) + 4} y={16}>
									{formatOffset(tick, bounds.from)}
								</text>
							</g>
						))}
						<g onClick={onPlotClick}>
							<rect x={0} y={0} width={plotW} height={total} fill="transparent" />
							{layouts.map((layout, index) => {
								const lane = lanes[index];
								if (!lane) return null;
								return (
									<LaneGroup
										key={lane.agentId}
										lane={lane}
										layout={layout}
										top={tops[index] ?? 0}
										alt={index % 2 === 1}
										width={plotW}
										patternId={id}
										selected={selectedAgent === lane.agentId}
										selection={selection}
										evidence={evidence}
										tabbable={tabbable}
										context={
											showsContext(lane)
												? contextSeries(requests.get(lane.agentId), lane.contextWindow, viewport)
												: undefined
										}
										onSelect={onSelect}
									/>
								);
							})}
							{arrows.map((arrow) => (
								<ArrowLine
									key={`${arrow.message.id}:${arrow.toLane}`}
									arrow={arrow}
									y1={laneY(arrow.fromLane)}
									y2={laneY(arrow.toLane)}
									headId={`${id}-head`}
									selected={selection?.kind === "message" && selection.id === arrow.message.id}
								/>
							))}
						</g>
						{nowX !== undefined && nowX >= 0 && nowX <= plotW ? (
							<g pointerEvents="none" className="pf-t-now">
								<line x1={nowX} x2={nowX} y1={0} y2={total} />
								<rect x={nowX - 16} y={2} width={32} height={16} rx={8} />
								<text x={nowX} y={14} textAnchor="middle">
									now
								</text>
							</g>
						) : null}
						{hover ? (
							<line className="pf-t-cross" x1={hover.x} x2={hover.x} y1={RULER_H} y2={total} pointerEvents="none" />
						) : null}
					</svg>
					{hover ? <TraceTooltip {...hover} limit={plotW} /> : null}
				</div>
			</div>
			<TraceTable events={visible} origin={bounds.from} />
			<TraceLegend />
		</section>
	);
}
