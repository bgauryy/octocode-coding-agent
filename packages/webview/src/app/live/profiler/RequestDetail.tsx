import type { ProfileLayer, ProfileRequest } from "@octocodeai/octocode-contracts";
import { useState } from "react";
import { span, stamp } from "../../model/format.ts";
import { Badge, Button } from "../../ui/primitives.tsx";
import { STATE_LABEL, Swatch } from "../ProfilerBar.tsx";
import { formatCost, formatPercent, formatTokens, hitRatio, promptTokens } from "../profiler-model.ts";
import { groupOfKind } from "./context-model.ts";
import { changedLayers } from "./session-state.ts";

const LAYER_WINDOW = 200;

function Fact({ name, value }: { name: string; value: string }) {
	return (
		<div>
			<dt>{name}</dt>
			<dd>{value}</dd>
		</div>
	);
}

/** The prompt in order: a segment per layer sized by tokens, breakpoint ticks, and the provider's cache outcome as a stripe. */
function LayerBar({ layers }: { layers: readonly ProfileLayer[] }) {
	const total = layers.reduce((sum, layer) => sum + layer.tokens, 0);
	if (!total) return null;
	const ticks = layers.flatMap((layer, at) =>
		layer.breakpoint ? [(layers.slice(0, at + 1).reduce((sum, row) => sum + row.tokens, 0) / total) * 100] : [],
	);
	return (
		<div className="pf-lbar">
			{/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a track of child spans, not an image file */}
			<div role="img" aria-label={`Prompt of ${formatTokens(total)} tokens in ${layers.length} layers`}>
				<div className="pf-lbar-main">
					{layers.map((layer, at) => (
						<span
							// oxlint-disable-next-line react/no-array-index-key -- layers have no id; their order is the prompt's
							key={at}
							className={`pf-g-${groupOfKind(layer.kind)}`}
							style={{ flexGrow: layer.tokens }}
							title={`${layer.label} · ${layer.tokens.toLocaleString()} tokens`}
						/>
					))}
				</div>
				<div className="pf-lbar-cache">
					{layers.map((layer, at) => (
						<span
							// oxlint-disable-next-line react/no-array-index-key -- same order as the bar above
							key={at}
							className={`pf-${layer.state}`}
							style={{ flexGrow: layer.tokens }}
						/>
					))}
				</div>
			</div>
			<div className="pf-lbar-ticks" aria-hidden="true">
				{ticks.map((at) => (
					<i key={at} style={{ left: `${at}%` }} />
				))}
			</div>
		</div>
	);
}

function LayerList({ request, only }: { request: ProfileRequest; only?: ReadonlySet<number> }) {
	const [all, setAll] = useState(false);
	const rows = request.layers
		.map((layer, position) => ({ layer, position }))
		.filter(({ position }) => !only || only.has(position));
	const shown = all ? rows : rows.slice(0, LAYER_WINDOW);
	const top = rows.reduce((most, { layer }) => Math.max(most, layer.tokens), 0);
	return (
		<>
			<ol className="pf-llist" aria-label={only ? "Changed layers" : "Layers in prompt order"}>
				{shown.map(({ layer, position }) => (
					<li key={`${position}:${layer.kind}`} className={position === request.firstBreak ? "is-break" : ""}>
						<span className="pf-layer-name">
							<span className="muted">{position + 1}</span> {layer.label}
							{layer.label !== layer.kind && <span className="muted"> ({layer.kind})</span>}
						</span>
						<span className="pf-layer-state">
							<span className="pf-num">{formatTokens(layer.tokens)}</span> <Swatch state={layer.state} />{" "}
							{STATE_LABEL[layer.state]}
						</span>
						<span className="pf-lrow-bar" aria-hidden="true">
							<span
								className={`pf-g-${groupOfKind(layer.kind)}`}
								style={{ width: `${top ? Math.max(1, (layer.tokens / top) * 100) : 0}%` }}
							/>
						</span>
						<span className="pf-layer-flags">
							{layer.breakpoint && <Badge title="The request placed a cache breakpoint here">▲ breakpoint</Badge>}
							{layer.changed && (
								<Badge tone="warning" title="Differs from the same position in the previous request">
									changed
								</Badge>
							)}
							{position === request.firstBreak && <Badge tone="danger">← first break</Badge>}
						</span>
					</li>
				))}
			</ol>
			{!all && rows.length > LAYER_WINDOW && (
				<Button size="sm" variant="ghost" onClick={() => setAll(true)}>
					Show all {rows.length} layers
				</Button>
			)}
		</>
	);
}

/**
 * One request: the facts, why the cache missed, the prompt as a proportional layer bar with its cache stripe and
 * breakpoints, and the layers in order (or only those that changed since the request before).
 */
export function RequestDetail({ request, window }: { request: ProfileRequest | undefined; window?: number }) {
	const [changedOnly, setChangedOnly] = useState(false);
	if (!request) return <p className="muted">Select a request to see its layers.</p>;
	const { usage } = request;
	const prompt = promptTokens(usage);
	const broken = request.firstBreak === undefined ? undefined : request.layers[request.firstBreak];
	const changed = changedLayers(request);
	return (
		<div
			className="pf-detail"
			aria-label={`Request ${request.index} of ${request.agentId}`}
			style={{ display: "grid", gap: 12 }}
		>
			<p className="muted" style={{ margin: 0 }}>
				{request.provider ? `${request.provider} · ` : ""}
				{request.model} · {stamp(request.at)}{" "}
				{request.estimated && <Badge title="Layers inferred from the transcript">estimated</Badge>}
			</p>
			<dl className="pf-facts">
				{request.durationMs !== undefined && <Fact name="Duration" value={span(request.durationMs)} />}
				<Fact name="Prompt" value={`${formatTokens(prompt)}${window ? ` · ${formatPercent(prompt / window)}` : ""}`} />
				<Fact name="Uncached" value={usage.input.toLocaleString()} />
				<Fact name="Cache read" value={usage.cacheRead.toLocaleString()} />
				<Fact name="Cache write" value={usage.cacheWrite.toLocaleString()} />
				<Fact name="Output" value={usage.output.toLocaleString()} />
				<Fact name="Hit rate" value={formatPercent(hitRatio(request))} />
				<Fact name="Cost" value={formatCost(usage.cost)} />
				{request.idleMs !== undefined && <Fact name="Idle before" value={span(request.idleMs)} />}
				{request.cacheGroup && <Fact name="Prefix hash" value={request.cacheGroup.prefix} />}
				{request.cacheGroup && <Fact name="Cache key" value={request.cacheGroup.key ?? "none"} />}
				{request.providerMissReason && (
					<Fact name="Provider miss" value={request.providerMissReason.replaceAll("_", " ")} />
				)}
			</dl>
			{broken && (
				<p className="pf-callout" role="note">
					<strong>First break: {broken.label}</strong> changed, so every layer after it was rewritten rather than read
					from cache.
				</p>
			)}
			{request.missReason && (
				<p className="pf-callout" role="note">
					<strong>Miss:</strong> {request.missReason}
				</p>
			)}
			<LayerBar layers={request.layers} />
			<div className="pf-actions">
				<Button size="sm" aria-pressed={changedOnly} onClick={() => setChangedOnly((value) => !value)}>
					Changed since previous ({changed.length})
				</Button>
			</div>
			{changedOnly && !changed.length ? (
				<p className="muted">No layer differs from the previous request.</p>
			) : (
				<LayerList
					request={request}
					only={changedOnly ? new Set(changed.map(({ position }) => position)) : undefined}
				/>
			)}
		</div>
	);
}
