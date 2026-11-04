import { existsSync } from "node:fs";
import { getBundledSkillsDir } from "../../config.ts";
import { effectivePlugins } from "../extensibility/toggles.ts";
import type { Settings } from "../settings-schema.ts";
import { type ContextView, type ContextViewInput, buildContextView } from "./context-view.ts";
import { configDiscovery, discoveryInput } from "./service.ts";

export interface ContextSnapshotOptions extends Pick<ContextViewInput, "loaded" | "mcp"> {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	contextRoot?: string;
	/** For the `plugin` kind: the settings in effect. Without them no plugin is listed. */
	settings?: Settings;
	builtinSkillsDir?: string;
}

/**
 * The loaded-context view of a session: discovery with project items of an untrusted folder included (marked, never
 * loaded), joined with what the loaders loaded. One walk of the folders per call; nothing is cached, so a reload is the
 * only refresh.
 */
export function collectContextView(options: ContextSnapshotOptions): ContextView {
	const input = discoveryInput({
		cwd: options.cwd,
		agentDir: options.agentDir,
		projectTrusted: options.projectTrusted,
		includeUntrusted: true,
		builtinSkillsDir: options.builtinSkillsDir ?? getBundledSkillsDir(),
		...(options.contextRoot ? { contextRoot: options.contextRoot } : {}),
		...(options.settings ? { plugins: effectivePlugins(options.settings, options.cwd) } : {}),
	});
	const discovery = configDiscovery.discoverAll(input);
	// Discovery lists every hook file Octocode may read (`hookSources`), whether or not it exists; the view counts the files that do.
	const hooks = discovery.get("hook");
	if (hooks)
		discovery.set(
			"hook",
			hooks.filter((item) => existsSync(item.provenance.path)),
		);
	return buildContextView({
		discovery,
		loaded: options.loaded,
		mcp: options.mcp,
		piRoots: input.piRoots,
	});
}
