import { currentToolRoles } from "../../../../mcp/src/api.ts";

/** The research server's tools this session has that can work on a saved page: its search tools and its file reader. */
type SavedPageTools = { search: string[]; reader?: string };

/** Which of the research server's search and reader tools (by their roles) are active. */
export function savedPageTools(active: readonly string[]): SavedPageTools {
	const research = currentToolRoles().research;
	if (!research) return { search: [] };
	const search = research.search.filter((tool) => active.includes(tool));
	return active.includes(research.reader) ? { search, reader: research.reader } : { search };
}

const code = (tools: readonly string[]) => tools.map((tool) => `\`${tool}\``).join(" or ");

/** How to reach the rest of a saved page, naming the tools this session has; without any, the generic wording stands. */
export function savedPageLead(tools: SavedPageTools): string {
	const reads = [
		tools.search.length > 0 && `search it with ${code(tools.search)}`,
		tools.reader && `read it by line range with ${code([tools.reader])}`,
	].filter(Boolean);
	return reads.length > 0 ? reads.join("; ") : "search it or read it by line range";
}
