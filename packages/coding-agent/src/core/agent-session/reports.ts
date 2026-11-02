/** Session reports that read the session without changing it: fork candidates and HTML export. */

import { contentText } from "@octocodeai/octocode-ai";
import { getThemeByName, theme } from "../../theme/theme.ts";
import type { ToolHtmlRenderer } from "../export-html/index.ts";
import type { ToolDefinition } from "../features/index.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SessionPublic } from "./host.ts";

/** All user messages of the session with their entry IDs, for the fork selector. */
export function getUserMessagesForForking(sessionManager: SessionManager): Array<{ entryId: string; text: string }> {
	const entries = sessionManager.getEntries();
	const result: Array<{ entryId: string; text: string }> = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user") continue;

		const text = contentText(entry.message.content, "");
		if (text) {
			result.push({ entryId: entry.id, text });
		}
	}

	return result;
}

/**
 * Export the session to HTML with the requested or configured theme and extension tool renderers. The exporter loads
 * on first use: it pulls in the web assets and terminal tool components, which headless SDK sessions never need.
 */
export async function exportToHtml(
	session: Pick<SessionPublic, "settingsManager" | "extensionRunner" | "sessionManager" | "agent">,
	getToolDefinition: (name: string) => ToolDefinition | undefined,
	outputPath: string | undefined,
	options: { themeName?: string },
): Promise<string> {
	const themeName = [options.themeName, session.settingsManager.getTheme()].find(
		(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
	);

	const [{ exportSessionToHtml }, { createToolHtmlRenderer }] = await Promise.all([
		import("../export-html/index.ts"),
		import("../export-html/tool-renderer.ts"),
	]);
	// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
	const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
		getToolRenderers: (name) => session.extensionRunner.resolveToolRenderers(name, () => getToolDefinition(name)),
		theme,
		cwd: session.sessionManager.getCwd(),
	});

	return await exportSessionToHtml(session.sessionManager, session.agent.state, {
		outputPath,
		themeName,
		toolRenderer,
	});
}
