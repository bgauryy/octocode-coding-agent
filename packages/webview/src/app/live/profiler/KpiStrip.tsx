import { cx } from "../../ui/primitives.tsx";
import type { Kpi, KpiId } from "./kpis.ts";

function Spark({ values }: { values: readonly number[] }) {
	if (values.length < 2) return null;
	const step = 60 / (values.length - 1);
	const points = values.map((value, at) => `${(at * step).toFixed(1)},${(16 - value * 14 - 1).toFixed(1)}`).join(" ");
	return (
		<svg
			className="pf-spark"
			width="60"
			height="16"
			viewBox="0 0 60 16"
			// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an inline svg chart, not an image file
			role="img"
			aria-label={`Hit rate trend over the last ${values.length} requests`}
		>
			<polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
		</svg>
	);
}

/** Six figures that answer "what is running, how full, what does it cost" before any row is read. Each is a button. */
export function KpiStrip({
	kpis,
	pressed,
	onPick,
}: {
	kpis: readonly Kpi[];
	/** Tiles whose filter or sort is on. */
	pressed: ReadonlySet<KpiId>;
	onPick: (id: KpiId) => void;
}) {
	return (
		<ul className="pf-kpis" aria-label="Session summary">
			{kpis.map((kpi) => (
				<li key={kpi.id}>
					<button
						type="button"
						className={cx("pf-kpi", kpi.tone && `is-${kpi.tone}`)}
						aria-pressed={pressed.has(kpi.id)}
						onClick={() => onPick(kpi.id)}
					>
						<span className="pf-kpi-label">{kpi.label}</span>
						<span className="pf-kpi-figure">{kpi.figure}</span>
						<span className="pf-kpi-sub">
							{kpi.spark && <Spark values={kpi.spark} />} {kpi.sub}
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

export function KpiSkeleton() {
	return (
		<output className="pf-kpis-skel" aria-label="Loading the session summary">
			{[0, 1, 2, 3, 4, 5].map((at) => (
				<span key={at} className="pf-skel" style={{ height: 84, borderRadius: 12 }} />
			))}
		</output>
	);
}
