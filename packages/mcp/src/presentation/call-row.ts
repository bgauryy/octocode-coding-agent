import { Text } from "@octocodeai/octocode-tui";
import { hostRender } from "../host.ts";
import type { McpToolRenderers } from "../host/types.ts";

/** The call row of an MCP tool labeled `server/tool`: its title and arguments. */
export function renderMcpCall(label: string): NonNullable<McpToolRenderers["renderCall"]> {
	return (args, theme, context) => {
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(hostRender().formatToolCallWithArgs(label, args, theme, context.expanded));
		return component;
	};
}
