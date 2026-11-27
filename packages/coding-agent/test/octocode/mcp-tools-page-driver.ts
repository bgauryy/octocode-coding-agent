import { installMcpHost, type McpHostPorts, type McpServerToolStates } from "../../../mcp/src/api.ts";
import type { McpFeatureState } from "../../../mcp/src/state.ts";
import { showServerTools } from "../../../mcp/src/tools-page.ts";
import type { McpMenu, McpUi } from "../../../mcp/src/ui.ts";
import { createMcpToolSwitch } from "../../src/octocode/mcp-host/tools.ts";

export interface ToolsPagePlace {
	cwd: string;
	agentDir: string;
	home?: string;
	trusted?: boolean;
	scope?: "global" | "project";
	live?: () => McpServerToolStates[] | undefined;
}

/** One menu as plain text: facts, rows (`label  badge  description`), details and error. */
export function menuText(menu: McpMenu): string {
	return [
		menu.title,
		...(menu.facts ?? []).map((fact) => `${fact.label} ${fact.value}`),
		...menu.items.map((item) => [item.label, item.badge, item.description].filter(Boolean).join("  ")),
		menu.details ?? "",
		menu.error ?? "",
	].join("\n");
}

/**
 * Runs the `/mcp` tools page of server `docs` against the real tool switch port, answering each menu with the next
 * of `choices` (undefined goes back). Resolves to every menu shown, in order.
 */
export async function runToolsPage(
	place: ToolsPagePlace,
	choices: Array<string | undefined>,
	server = "docs",
): Promise<McpMenu[]> {
	const port = createMcpToolSwitch({
		live: place.live ?? (() => undefined),
		...(place.home ? { home: place.home } : {}),
	});
	// The page names the host's agent folder; the test's isolated one replaces it.
	const at = <T extends { agentDir: string }>(where: T): T => ({ ...where, agentDir: place.agentDir });
	const toolSwitch: McpHostPorts["toolSwitch"] = {
		view: (where, ...rest) => port.view(at(where), ...rest),
		pin: (where, ...rest) => port.pin(at(where), ...rest),
		assign: (where, ...rest) => port.assign(at(where), ...rest),
		setExposure: (where, ...rest) => port.setExposure(at(where), ...rest),
	};
	installMcpHost({ toolSwitch });
	const state = {
		sessionCwd: place.cwd,
		projectTrusted: place.trusted ?? true,
		servers: [],
		findServer: () => undefined,
		subscribe: () => () => {},
	} as unknown as McpFeatureState;
	const menus: McpMenu[] = [];
	const queue = [...choices];
	const ui: McpUi = {
		menu: async (build) => {
			menus.push(build());
			return queue.shift();
		},
		status: () => {},
		redirectUrl: async () => undefined,
	};
	await showServerTools(state, ui, server, place.scope);
	return menus;
}
