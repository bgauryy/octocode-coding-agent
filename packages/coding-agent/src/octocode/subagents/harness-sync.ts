import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { requestMcpReload } from "../../../../mcp/src/api.ts";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { Settings } from "../../core/settings-schema.ts";

/**
 * A running subagent follows the parent's `/harness` vendor switches. The parent applies a switch to its own MCP servers
 * at once, but a child is another process that read the switch settings when it started. The saved settings are the
 * channel both sides already share, so the child compares them before each request it sends (a new prompt, or the next
 * turn of a run) and, when a `harness:` switch changed, runs the same MCP reload the parent ran (`requestMcpReload`): the
 * servers a vendor adds connect, the ones it removes close, and the next request's `<mcps>` block describes the result.
 * The reload applies the child's own tool selection, so a profile that restricts MCP stays restricted, and the
 * permission rules for MCP calls (a read-only role included) are those of the child's session, as at its start.
 *
 * Skills are not part of this: the parent changes its own skill list only on `/reload`, which ends its running children,
 * so a child's skill list (the parent's, handed over at start) never disagrees with its parent's.
 */

const isHarnessKey = ([key]: [string, boolean]) => key.startsWith("harness:");
const harnessToggles = (settings: Settings) =>
	Object.entries(settings.toggles ?? {})
		.filter(isHarnessKey)
		.sort(([a], [b]) => a.localeCompare(b));

/** The saved `harness:` switches, global and project: what decides which vendors' MCP servers load. */
function harnessSwitches(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): string {
	const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
	const [problem] = manager.drainErrors();
	if (problem) throw new Error(`Cannot read ${problem.path}: ${problem.error.message}`);
	return JSON.stringify([harnessToggles(manager.getGlobalSettings()), harnessToggles(manager.getProjectSettings())]);
}

/** Registers the child's check for a vendor switch; a top-level session has no use for it (its `/harness` reloads MCP itself). */
export function registerHarnessSync(api: ExtensionAPI): void {
	let seen: string | undefined;
	const report = (what: string, error: unknown): void => {
		process.stderr.write(`Harness switches not applied to this subagent: ${what}: ${errorMessage(error)}\n`);
	};
	const remember = (ctx: ExtensionContext) => {
		try {
			seen = harnessSwitches(ctx);
		} catch (error) {
			seen = undefined;
			report("the start settings", error);
		}
	};
	const sync = async (ctx: ExtensionContext): Promise<void> => {
		if (seen === undefined) return remember(ctx);
		let now: string;
		try {
			now = harnessSwitches(ctx);
		} catch (error) {
			// Kept as is: the next turn reads the settings again.
			return report("settings unreadable", error);
		}
		if (now === seen) return;
		seen = now;
		try {
			await requestMcpReload(api.events);
		} catch (error) {
			report("the MCP reload failed", error);
		}
	};
	api.on("session_start", (_event, ctx) => {
		remember(ctx);
	});
	// The MCP owner describes its servers in `before_agent_start` and `turn_prompt`, which run after these hooks have
	// reloaded: `input` precedes a new prompt's first request, `turn_end` each later request of the run.
	api.on("input", async (_event, ctx) => {
		await sync(ctx);
		return { action: "continue" as const };
	});
	api.on("turn_end", async (_event, ctx) => {
		await sync(ctx);
		return undefined;
	});
}
