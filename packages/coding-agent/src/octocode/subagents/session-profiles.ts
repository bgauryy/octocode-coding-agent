import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { effectivePlugins } from "../../core/extensibility/toggles.ts";
import { desktopEnabled } from "../../../../mcp/src/api.ts";
import { getAgentDir } from "../../config.ts";
import { PROFILE_DECLARABLE } from "../permission/mode.ts";
import { notify } from "../shared/commands.ts";
import { interactive } from "../shared/interactive.ts";
import { type AgentProfile, loadProfiles, profileFileName } from "./profiles.ts";

/**
 * The profiles of a session: bundled, user, trusted-project, and the `<plugin>:<agent>` profiles of the enabled Claude plugins
 * (`api.settings.get()` holds project plugins only for a trusted folder). `refused` says why a profile file was skipped, by the
 * name the `agent` tool is asked for; what a notice covers is shown in an interactive session only.
 */
export function loadSessionProfiles(
	api: FeatureSetup,
	ctx: FeatureContext,
	isSubagent: boolean,
): { profiles: Map<string, AgentProfile>; refused: Map<string, string> } {
	const refused = new Map<string, string>();
	const skipped: string[] = [];
	const shadowed: string[] = [];
	const notes: string[] = [];
	const profiles = loadProfiles(
		ctx.cwd,
		undefined,
		ctx.isProjectTrusted(),
		process.env,
		(file, error, name) => {
			skipped.push(`${file}: ${errorMessage(error)}`);
			refused.set(name ?? profileFileName(file), errorMessage(error));
		},
		(name, file, replaced) => shadowed.push(`${name}: ${file} replaces ${replaced}`),
		{ plugins: effectivePlugins(api.settings.get(), ctx.cwd), onNote: (message) => notes.push(message) },
	);
	// The `desktop` specialist drives the built-in server: without Cua Driver it would only waste prompt space and fail, and a
	// main session nobody can answer (print, JSON) has no one to approve its start. The specialist's own child keeps its profile.
	const desktopOn = desktopEnabled({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
	if (!desktopOn || !(isSubagent || interactive(ctx, isSubagent))) profiles.delete("desktop");
	if (!interactive(ctx, isSubagent)) return { profiles, refused };
	if (shadowed.length > 0)
		notify(ctx.ui, `Project subagent profiles replace profiles loaded earlier:\n${shadowed.join("\n")}`, "warning");
	if (skipped.length > 0)
		notify(ctx.ui, `Skipped subagent profiles that could not be read:\n${skipped.join("\n")}`, "warning");
	if (notes.length > 0) notify(ctx.ui, `Plugin subagent profiles:\n${notes.join("\n")}`, "warning");
	const ignored = [...profiles.values()].filter((profile) => profile.ignoredPermissions?.length);
	if (ignored.length > 0)
		notify(
			ctx.ui,
			`Ignored permissions a subagent profile cannot declare (only ${PROFILE_DECLARABLE.join(", ")}):\n${ignored.map((profile) => `${profile.name}: ${profile.ignoredPermissions!.join(", ")}`).join("\n")}`,
			"warning",
		);
	return { profiles, refused };
}
