import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { isOctocodeTool } from "../shared/octocode-tools.ts";

/**
 * Every native registration declares its permission owner here. Adding a tool requires an explicit review of its
 * effects; a read-only hint alone cannot bypass that review. Extensions outside Octocode retain their own contract.
 */
const NATIVE_PERMISSION_OWNERS = new Map([
	["bash", "gate/classify: shell and destructive commands"],
	["debug", "gate/classify: debugger execution; termination only stops an existing session"],
	["browser", "gate/classify plus BrowserTool: page actions, host access, uploads and control"],
	["web", "gate/classify plus Web tool: search, resolved URLs and private hosts"],
	["file", "File tool: checked mutation transaction and source-policy projection"],
	["memory", "Memory tool: persistent memory scope checks"],
	["agent", "Agent modes: task/profile and external-process checks; session coordination and messages"],
	["askUser", "Session UI only: collects the user's answers"],
	["backlog", "Session workspace state only: backlog records and comments"],
	["archive", "Archive tool: authorized session history, checked by the history reader"],
]);

/** Fail before an unreviewed native tool enters the registry, including late registrations. */
export function withNativePermissionOwners(pi: ExtensionAPI): ExtensionAPI {
	const registerTool: ExtensionAPI["registerTool"] = (tool) => {
		if (!NATIVE_PERMISSION_OWNERS.has(tool.name) && !isOctocodeTool(tool.name)) {
			throw new Error(`Native tool ${tool.name} has no permission owner; register its gate or internal check first.`);
		}
		pi.registerTool(tool);
	};
	return new Proxy(pi, {
		get(target, property, receiver) {
			return property === "registerTool" ? registerTool : Reflect.get(target, property, receiver);
		},
	});
}
