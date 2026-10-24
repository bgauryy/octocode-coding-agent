import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { AgentSession } from "../../../core/agent-session.ts";

/** Coordinator identity never competes with token totals for the last few footer columns. */
export function coordinatorFooterLines(session: AgentSession, width: number): string[] {
	const { model, thinkingLevel } = session.state;
	const thinking = model?.reasoning ? thinkingLevel || "off" : "unavailable";
	const identityLabels = [
		`Coordinator · thinking ${thinking}`,
		`Main · think ${thinking}`,
		`think ${thinking}`,
		thinking,
	];
	const identity = identityLabels.find((label) => visibleWidth(label) <= width) ?? thinking;
	const selection = model ? `${model.provider}/${model.id}` : "No model selected · /providers";
	const combined = `${identity} · ${selection}`;
	const lines =
		visibleWidth(combined) <= width
			? [combined]
			: [truncateToWidth(identity, width), truncateToWidth(`Model · ${selection}`, width)];
	const routed = session.routedModel;
	if (routed) {
		const provider = routed.model.provider ? `${routed.model.provider}/` : "";
		lines.push(
			truncateToWidth(
				`Latest route · ${provider}${routed.model.id} · thinking ${routed.thinkingLevel ?? "off"}`,
				width,
			),
		);
	}
	return lines;
}
