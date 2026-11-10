import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ViewProps } from "../extension.ts";
import { movedProfilerPanel } from "../model/route.ts";
import { Button, cx } from "../ui/primitives.tsx";
import { Drawer } from "./profiler/Drawer.tsx";
import type { Evidence } from "./profiler/insight-model.ts";
import { InsightsPanel } from "./profiler/InsightsPanel.tsx";
import { MessagesPanel } from "./profiler/MessagesPanel.tsx";
import { type Navigate, OverviewPanel } from "./profiler/OverviewPanel.tsx";
import type { PanelProps } from "./profiler/panel-props.ts";
import { ProfilerToolbar } from "./profiler/ProfilerToolbar.tsx";
import { emptySession, reduceSession, sessionRequestMap, visibleFindings } from "./profiler/session-state.ts";
import { TracePanel } from "./profiler/TracePanel.tsx";
import { setClockSkew } from "./profiler/use-now.ts";
import { agentTree } from "./profiler-model.ts";
import { useLive } from "./session.tsx";

const PANELS = [
	{ name: "overview", label: "Overview" },
	{ name: "trace", label: "Trace" },
	{ name: "messages", label: "Messages" },
	{ name: "insights", label: "Insights" },
] as const;
export type PanelName = (typeof PANELS)[number]["name"];

function panelOf(value: string | undefined): PanelName {
	const name = movedProfilerPanel(value) ?? value;
	return PANELS.find((panel) => panel.name === name)?.name ?? "overview";
}
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const DRAWER_DEFAULT = 380;
const TAB_KEYS = ["ArrowRight", "ArrowLeft", "Home", "End"];

/**
 * A DevTools-style profiler: Overview, Trace, Messages and Insights share one toolbar, one selection (shown in one
 * drawer), one brushed range and one clock. Fed by the profiler routes and live frames; it only reads and draws.
 */
export function ProfilerView({ params, setParams }: ViewProps) {
	const { api, profiler } = useLive();
	const [session, dispatch] = useReducer(reduceSession, emptySession);
	const [error, setError] = useState<string>();
	const [loaded, setLoaded] = useState(false);
	const [reload, setReload] = useState(0);
	const [drawerWidth, setDrawerWidth] = useState(DRAWER_DEFAULT);
	/** The finding last opened from Insights: the Trace rings all of its evidence. */
	const [evidence, setEvidence] = useState<readonly Evidence[]>();
	const latest = useRef(session);
	useEffect(() => {
		latest.current = session;
	});
	const panel = panelOf(params.panel);
	const { core } = session;

	// Subscribe before reading so a request that finishes in between is merged, not lost.
	useEffect(() => {
		const stop = profiler.subscribe((update) => dispatch({ type: "update", value: update }));
		const controller = new AbortController();
		const { signal } = controller;
		const fail = (reason: unknown) => {
			if (!signal.aborted) setError(message(reason));
		};
		api
			.profilerAgents(signal)
			.then((value) => {
				setClockSkew(Date.now() - value.generatedAt);
				dispatch({ type: "agents", value });
				setError(undefined);
				setLoaded(true);
			})
			.catch(fail);
		void (async () => {
			let since: number | undefined;
			for (;;) {
				const page = await api.profilerTimeline(since, signal);
				dispatch({ type: "timeline", value: page });
				if (!page.hasMore || page.until === since) return;
				since = page.until;
			}
		})().catch(fail);
		api
			.profilerInsights(signal)
			.then((value) => dispatch({ type: "insights", value: value.findings }))
			.catch(fail);
		return () => {
			stop();
			controller.abort();
		};
	}, [api, profiler, reload]);

	// Read every profiled agent's requests, one page at a time; a raised `more` (a missed frame) reads again.
	// oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- undefined (never read) counts as unread, false as done
	const next = core.agents.find((agent) => agent.profiled && core.more[agent.id] !== false);
	const nextId = next?.id;
	const nextCount = nextId === undefined ? 0 : (core.requests[nextId]?.length ?? 0);
	const nextMore = nextId === undefined ? undefined : core.more[nextId];
	useEffect(() => {
		if (nextId === undefined) return;
		const controller = new AbortController();
		const loadedRequests = latest.current.core.requests[nextId];
		const after = latest.current.core.more[nextId] === undefined ? undefined : loadedRequests?.at(-1)?.index;
		api
			.profilerRequests(nextId, after, controller.signal)
			.then((value) => dispatch({ type: "requests", value }))
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(message(reason));
			});
		return () => controller.abort();
	}, [api, nextId, nextCount, nextMore]);

	const agents = useMemo(() => agentTree(core.agents).map((row) => row.agent), [core.agents]);
	const requests = useMemo(() => sessionRequestMap(session), [session]);
	const findings = useMemo(() => visibleFindings(session), [session]);
	const waiting = (session.timeline?.messages ?? []).filter(
		(item) => item.state === "awaiting reply" || item.state === "dead-lettered",
	).length;
	const issues = (session.findings ?? []).filter((finding) => finding.severity !== "low").length;
	const badge: Partial<Record<PanelName, number>> = { messages: waiting, insights: issues };

	const props: PanelProps = {
		agents,
		requests,
		timeline: session.timeline,
		selection: session.selection,
		onSelect: (selection) => dispatch({ type: "select", value: selection }),
		range: session.range,
		onRange: (range) => dispatch({ type: "range", value: range }),
		filter: session.filter,
	};
	const navigate: Navigate = (target, options) => {
		if (options?.filter !== undefined) dispatch({ type: "filter", value: options.filter });
		if (options?.select) dispatch({ type: "select", value: options.select });
		setParams({ ...params, panel: target });
	};

	function onTabKeys(event: KeyboardEvent<HTMLDivElement>) {
		if (!TAB_KEYS.includes(event.key)) return;
		const at = PANELS.findIndex((item) => item.name === panel);
		const step = event.key === "ArrowRight" ? 1 : -1;
		const target =
			event.key === "Home"
				? PANELS[0]
				: event.key === "End"
					? PANELS[PANELS.length - 1]
					: PANELS[(at + step + PANELS.length) % PANELS.length];
		setParams({ ...params, panel: target.name });
		event.preventDefault();
		requestAnimationFrame(() => document.getElementById(`pf-tab-${target.name}`)?.focus());
	}

	// Esc closes the drawer from anywhere on the page except a field, where it belongs to the field.
	function onPageKeys(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key !== "Escape" || !session.selection) return;
		if ((event.target as HTMLElement).closest("input, select, textarea")) return;
		dispatch({ type: "select", value: undefined });
	}

	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the page only relays Esc from the controls inside it
		<div className="view profiler-view" onKeyDown={onPageKeys}>
			<ProfilerToolbar
				sessionId={session.timeline?.sessionId || undefined}
				startedAt={core.startedAt}
				paused={session.paused}
				held={session.held.length}
				range={session.range}
				filter={session.filter}
				onPause={(value) => dispatch({ type: "pause", value })}
				onRange={props.onRange}
				onFilter={(value) => dispatch({ type: "filter", value })}
			/>
			{error && (
				<p className="pf-error" role="alert">
					{error}{" "}
					<Button size="sm" onClick={() => setReload((value) => value + 1)}>
						Try again
					</Button>
				</p>
			)}
			{/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- the tabs inside take focus; the strip only relays arrow keys */}
			<div className="pf-tabs" role="tablist" aria-label="Profiler panels" onKeyDown={onTabKeys}>
				{PANELS.map((item) => {
					const count = badge[item.name];
					return (
						<button
							key={item.name}
							type="button"
							role="tab"
							id={`pf-tab-${item.name}`}
							aria-selected={panel === item.name}
							aria-controls="pf-panel"
							tabIndex={panel === item.name ? 0 : -1}
							className="pf-tab"
							onClick={() => setParams({ ...params, panel: item.name })}
						>
							{item.label}
							{count ? <span className="pf-count is-alert">{count}</span> : null}
						</button>
					);
				})}
			</div>
			<div
				className={cx("pf-body", session.selection && "has-drawer")}
				style={{ "--pf-drawer": `${drawerWidth}px` } as CSSProperties}
			>
				<div id="pf-panel" role="tabpanel" aria-labelledby={`pf-tab-${panel}`}>
					{panel === "overview" && (loaded || !error) ? (
						<OverviewPanel
							loaded={loaded}
							agents={core.agents}
							requests={requests}
							findings={session.findings && findings}
							selection={session.selection}
							filter={session.filter}
							startedAt={core.startedAt}
							onSelect={props.onSelect}
							onNavigate={navigate}
						/>
					) : !loaded ? (
						<output className="muted">{error ? "The profiler is unavailable." : "Loading…"}</output>
					) : panel === "trace" ? (
						<TracePanel {...props} evidence={evidence} />
					) : panel === "messages" ? (
						<MessagesPanel {...props} />
					) : (
						<InsightsPanel
							findings={session.findings && findings}
							onSelect={props.onSelect}
							onEvidence={(finding) => {
								setEvidence(finding.evidence);
								setParams({ ...params, panel: "trace" });
							}}
						/>
					)}
				</div>
				{session.selection && (
					<Drawer
						selection={session.selection}
						agents={core.agents}
						requests={requests}
						timeline={session.timeline}
						width={drawerWidth}
						onWidth={setDrawerWidth}
						onSelect={props.onSelect}
						onStep={(by) => dispatch({ type: "step", by })}
					/>
				)}
			</div>
		</div>
	);
}
