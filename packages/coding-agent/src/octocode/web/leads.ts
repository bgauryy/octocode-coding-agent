import { currentToolRoles } from "../../../../mcp/src/api.ts";

/** The research server's tools this session has that can work on a saved page: its search tools, file reader and judge. */
type SavedPageTools = { search: string[]; reader?: string; judge?: string };

/** Which of the research server's search, reader and judge tools (by their roles) are active. */
export function savedPageTools(active: readonly string[]): SavedPageTools {
	const research = currentToolRoles().research;
	if (!research) return { search: [] };
	return {
		search: research.search.filter((tool) => active.includes(tool)),
		...(active.includes(research.reader) ? { reader: research.reader } : {}),
		...(research.judge && active.includes(research.judge) ? { judge: research.judge } : {}),
	};
}

const code = (tools: readonly string[]) => tools.map((tool) => `\`${tool}\``).join(" or ");

/** How to reach the rest of a saved page, naming the tools this session has; without any, the generic wording stands. */
export function savedPageLead(tools: SavedPageTools): string {
	const reads = [
		tools.judge && `judge it with ${code([tools.judge])} (url or saved path) before reading`,
		tools.search.length > 0 && `search it with ${code(tools.search)}`,
		tools.reader && `read it by line range with ${code([tools.reader])}`,
	].filter(Boolean);
	return reads.length > 0 ? reads.join("; ") : "search it or read it by line range";
}
