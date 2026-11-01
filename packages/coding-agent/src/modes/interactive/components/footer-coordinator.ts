import { ELLIPSIS, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { plainText } from "./styled-line.ts";

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
	// Model ids and providers can come from vendor model lists and the remote catalog.
	const selection = model ? plainText(`${model.provider}/${model.id}`) : "No model selected · /login";
	const combined = `${identity} · ${selection}`;
	const lines =
		visibleWidth(combined) <= width
			? [combined]
			: [truncateToWidth(identity, width, ELLIPSIS), truncateToWidth(`Model · ${selection}`, width, ELLIPSIS)];
	const routed = session.routedModel;
	if (routed) {
		const provider = routed.model.provider ? `${plainText(routed.model.provider)}/` : "";
		lines.push(
			truncateToWidth(
				`Latest route · ${provider}${plainText(routed.model.id)} · thinking ${routed.thinkingLevel ?? "off"}`,
				width,
				ELLIPSIS,
			),
		);
	}
	return lines;
}
