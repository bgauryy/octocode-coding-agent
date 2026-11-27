import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { cx } from "../ui/primitives.tsx";
import { contextText, quotaWarnings, sigmaText, sigmaTitle } from "./usage-text.ts";

/**
 * Under the composer, in the terminal footer's words: how full the context is, the session's spend with money apart
 * from the plan estimate (`Σ`, left out until something was spent), and a warning for each plan quota window at 70 %
 * or more. Absent until the host publishes spend or quota (an older host never does).
 */
export function SessionUsageStrip({
	usage,
	quota,
	provider,
}: Pick<ApplicationSnapshot, "usage" | "quota"> & {
	/** The selected model's provider, whose quota the footer names without the provider. */
	provider?: string;
}) {
	const warnings = quotaWarnings(quota, provider);
	const context = contextText(usage);
	const sigma = usage && sigmaText(usage);
	if (!context && !sigma && !warnings.length) return null;
	return (
		<section className="usage-strip" aria-label="Session usage">
			{context && (
				<span
					className={cx(context.tone && "usage-quota", context.tone && `tone-${context.tone}`)}
					title="How full the model's context window is; Octocode compacts the conversation before it fills."
				>
					{context.text}
				</span>
			)}
			{usage && sigma && <span title={sigmaTitle(usage)}>{sigma}</span>}
			{warnings.map((warning) => (
				<output key={warning.key} className={cx("usage-quota", `tone-${warning.tone}`)}>
					{warning.text}
				</output>
			))}
		</section>
	);
}
