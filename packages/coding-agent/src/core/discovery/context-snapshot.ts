import { existsSync, readFileSync } from "node:fs";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { parseConfigDocument } from "../../utils/config-document.ts";
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
}

/**
 * Whether a hook file defines at least one hook. Claude's `settings.json` and Codex's `config.toml` exist for other
 * settings and are not hook sources then; a file that cannot be read or parsed still counts, so its failure shows.
 */
function definesHooks(file: string): boolean {
	if (!existsSync(file)) return false;
	try {
		const document = parseConfigDocument(readFileSync(file, "utf8"), file);
		const hooks = isRecord(document) ? document.hooks : undefined;
		return isRecord(hooks) && Object.values(hooks).some((groups) => !Array.isArray(groups) || groups.length > 0);
	} catch {
		return true;
	}
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
		...(options.contextRoot ? { contextRoot: options.contextRoot } : {}),
		...(options.settings ? { plugins: effectivePlugins(options.settings, options.cwd) } : {}),
	});
	const discovery = configDiscovery.discoverAll(input);
	// Discovery lists every hook file Octocode may read (`hookSources`), whether or not it exists; the view counts the files that define hooks.
	const hooks = discovery.get("hook");
	if (hooks)
		discovery.set(
			"hook",
			hooks.filter((item) => definesHooks(item.provenance.path)),
		);
	return buildContextView({
		discovery,
		loaded: options.loaded,
		mcp: options.mcp,
		piRoots: input.piRoots,
	});
}
