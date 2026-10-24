import type { LiveExtension } from "../extension.ts";
import { readLaunch } from "../model/route.ts";
import { AgentIcon, HistoryIcon, PulseIcon } from "../ui/icons.tsx";
import { ActivityView } from "./ActivityView.tsx";
import { AgentsView } from "./AgentsView.tsx";
import { AuditView } from "./AuditView.tsx";
import { Editor } from "./Editor.tsx";
import { ItemQuickAction } from "./ItemImplementation.tsx";
import { ItemActions, ItemActivity } from "./ItemPanels.tsx";
import { Markdown } from "./Markdown.tsx";
import { ConnectionStatus, LiveProvider } from "./session.tsx";

const ACCESS_KEY = "backlog-access";

export const live: LiveExtension | null = {
	takeAccess() {
		const launch = readLaunch(location.hash);
		try {
			if (launch) {
				sessionStorage.setItem(ACCESS_KEY, launch.access);
				history.replaceState(null, "", launch.hash);
				return launch.access;
			}
			return sessionStorage.getItem(ACCESS_KEY) ?? "";
		} catch {
			if (launch) location.hash = launch.hash;
			return launch?.access ?? "";
		}
	},
	views: [
		{ name: "agents", label: "Agents", Icon: AgentIcon, Component: AgentsView },
		{ name: "activity", label: "Activity", Icon: PulseIcon, Component: ActivityView },
		{ name: "audit", label: "Audit", Icon: HistoryIcon, Component: AuditView },
	],
	Provider: LiveProvider,
	ConnectionStatus,
	ItemActions,
	ItemQuickAction,
	ItemActivity,
	Editor,
	RichText: Markdown,
};
