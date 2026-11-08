import type { ProfileLayerKind } from "@octocodeai/octocode-contracts";
import { cx } from "../../ui/primitives.tsx";
import { formatTokens } from "../profiler-model.ts";
import { contextCaption, contextLevel, contextSegments, groupLabel, type ContextSegment } from "./context-model.ts";

export interface ContextBarProps {
	/** The context's tokens by layer kind (`ProfileAgent.contextLayers`). */
	layers?: readonly { kind: ProfileLayerKind; tokens: number }[];
	/** The whole context, the reply included (`ProfileAgent.contextTokens`); defaults to the layers' sum. */
	tokens?: number;
	/** The model's window: the track. Without it the bar shows the tokens alone, with no percentage. */
	window?: number;
	/** Where auto-compaction triggers: draws a tick and hatches the buffer after it. */
	compactAt?: number;
	/** The layer split is estimated: the caption says `≈`. */
	estimated?: boolean;
	/** Names the bar for assistive technology, e.g. the agent id. */
	label?: string;
	/** `sm` for a dense list, `md` (default) for a card. */
	size?: "sm" | "md";
	/** The `128k / 200k · 64%` line beside the bar; on by default. */
	caption?: boolean;
}

const pct = (part: number, whole: number) => `${Math.min(100, (part / whole) * 100)}%`;

function describe(segments: readonly ContextSegment[], text: string, label: string | undefined): string {
	const parts = segments.map((segment) => `${groupLabel(segment.key)} ${formatTokens(segment.tokens)}`);
	return `${label ? `${label} context` : "Context"} ${text}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

/**
 * An agent's context as one stacked bar: a segment per layer group on the window's track, a tick where compaction
 * starts. Colour never carries it alone: the caption has the figures and a ⚠ at 90% of the threshold.
 */
export function ContextBar({
	layers,
	tokens,
	window,
	compactAt,
	estimated,
	label,
	size = "md",
	caption = true,
}: ContextBarProps) {
	const used = tokens ?? layers?.reduce((sum, layer) => sum + layer.tokens, 0);
	if (used === undefined) return <p className="pf-ctx-empty muted">No context measured yet</p>;
	const track = window ?? used;
	const segments = contextSegments(layers, used, track);
	const level = contextLevel(used, compactAt ?? window);
	const text = `${estimated ? "≈ " : ""}${contextCaption(used, window)}`;
	const tick = window && compactAt && compactAt < window ? compactAt : undefined;
	return (
		<div className={cx("pf-ctx", `pf-ctx-${size}`, `is-${level}`)}>
			{/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a track of child spans, not an image file */}
			<span className="pf-ctx-track" role="img" aria-label={describe(segments, text, label)}>
				{tick && <span className="pf-ctx-buffer" style={{ left: pct(tick, window ?? 1), right: 0 }} />}
				<span className="pf-ctx-fill" style={{ width: pct(used, track) }}>
					{segments.map((segment) => (
						<span
							key={segment.key}
							className={`pf-ctx-seg pf-g-${segment.key}`}
							style={{ flexGrow: segment.tokens }}
							title={`${groupLabel(segment.key)} · ${segment.tokens.toLocaleString()} tokens`}
						/>
					))}
				</span>
				{tick && <span className="pf-ctx-tick" style={{ left: pct(tick, window ?? 1) }} />}
			</span>
			{caption && (
				<span className="pf-ctx-text">
					{text}
					{compactAt && ` · compacts at ${formatTokens(compactAt)}`}
					{level === "danger" && <strong className="pf-ctx-warn"> ⚠ compaction soon</strong>}
				</span>
			)}
		</div>
	);
}

/** The bar's key with exact figures: a swatch, the group's name and its tokens, then what is left of the window. */
export function ContextLegend({ layers, tokens, window }: Pick<ContextBarProps, "layers" | "tokens" | "window">) {
	const used = tokens ?? layers?.reduce((sum, layer) => sum + layer.tokens, 0) ?? 0;
	const segments = contextSegments(layers, used, window ?? used, false);
	return (
		<ul className="pf-ctx-legend" aria-label="Context by layer">
			{segments.map((segment) => (
				<li key={segment.key}>
					<span className={`pf-dot pf-g-${segment.key}`} aria-hidden="true" /> {groupLabel(segment.key)}{" "}
					<span className="pf-num">{formatTokens(segment.tokens)}</span>
				</li>
			))}
			{window !== undefined && window > used && (
				<li>
					<span className="pf-dot pf-g-free" aria-hidden="true" /> free{" "}
					<span className="pf-num">{formatTokens(window - used)}</span>
				</li>
			)}
		</ul>
	);
}
