import type { LiveExtension } from "../extension.ts";
import { takeAccess } from "../../access.ts";
import { AgentIcon, DocIcon, HistoryIcon, PulseIcon, ResearchIcon } from "../ui/icons.tsx";
import { ActivityView } from "./ActivityView.tsx";
import { AgentsView } from "./AgentsView.tsx";
import { AuditView } from "./AuditView.tsx";
import { DocsView } from "./DocsView.tsx";
import { Editor } from "./Editor.tsx";
import { hierarchyControls } from "./hierarchy.tsx";
import { ItemQuickAction } from "./ItemImplementation.tsx";
import { ItemActions, ItemActivity } from "./ItemPanels.tsx";
import { Markdown } from "./Markdown.tsx";
import { RfcView, ResearchView } from "./ReportsView.tsx";
import { NeedsYouAnswer, useNeedsYou } from "./NeedsYou.tsx";
import { Notifications } from "./Notifications.tsx";
import { ConnectionStatus, LiveProvider } from "./session.tsx";
import { themePrefs } from "./web-prefs.ts";

export const live: LiveExtension | null = {
	takeAccess,
	views: [
		{ name: "rfc", label: "RFC", Icon: DocIcon, Component: RfcView },
		{ name: "research", label: "Research", Icon: ResearchIcon, Component: ResearchView },
		{ name: "docs", label: "Docs", Icon: DocIcon, Component: DocsView },
		{ name: "agents", label: "Agents", Icon: AgentIcon, Component: AgentsView },
		{ name: "activity", label: "Activity", Icon: PulseIcon, Component: ActivityView },
		{ name: "audit", label: "Audit", Icon: HistoryIcon, Component: AuditView },
	],
	Provider: LiveProvider,
	ConnectionStatus,
	themePrefs,
	Notifications,
	useNeedsYou,
	NeedsYouAnswer,
	ItemActions,
	controls: hierarchyControls,
	ItemQuickAction,
	ItemActivity,
	Editor,
	RichText: Markdown,
};
