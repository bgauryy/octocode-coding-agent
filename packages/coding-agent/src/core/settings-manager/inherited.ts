import { readJsonFile } from "../../../../common/src/json.ts";
import { configDiscovery, discoveryInput } from "../discovery/service.ts";
import { deepMergeObjects, isMergeableObject } from "./merge.ts";

/** A note about a Pi file (the shape of `SettingsWarning`, which this file cannot import without a cycle with storage). */
interface InheritedWarning {
	scope: "global" | "project";
	path: string;
	message: string;
}

/** Pi's settings, merged under Octocode's. They are read, never written: a save writes only Octocode's own values. */
export interface InheritedSettings {
	settings: Record<string, unknown>;
	warnings: InheritedWarning[];
}

/** Keys of a Pi settings file that are not inherited: resources resolve against their own folder, the rest is per install. */
const NOT_INHERITED = [
	"packages",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"sessionDir",
	"deviceId",
	"trackingId",
	"enableAnalytics",
	"defaultProjectTrust",
];

/**
 * The settings Octocode reads from Pi: `~/.pi/agent/settings.json` and `~/.pi/settings.json`, then, in a trusted folder,
 * `<cwd>/.pi/settings.json` above them. Discovery lists the files; a file that does not parse is a warning and does not
 * stop Octocode's own settings from loading.
 */
export function readInheritedSettings(cwd: string, agentDir: string, projectTrusted: boolean): InheritedSettings {
	const files = configDiscovery
		.discover("setting", discoveryInput({ cwd, agentDir, projectTrusted }))
		.filter((item) => item.provenance.product === "pi" && item.loaded)
		.reverse();
	let settings: Record<string, unknown> = {};
	const warnings: InheritedWarning[] = [];
	for (const { provenance } of files) {
		const { path, scope } = provenance;
		try {
			const file: unknown = readJsonFile(path);
			if (!isMergeableObject(file)) throw new Error("expected a JSON object");
			for (const key of NOT_INHERITED) delete file[key];
			// A project file cannot publish this machine to another device; only a global file may.
			if (scope === "project" && isMergeableObject(file.remote)) delete file.remote.autoStart;
			settings = deepMergeObjects(settings, file);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			warnings.push({
				scope: scope === "project" ? "project" : "global",
				path,
				message: `Pi settings were not read: ${reason}`,
			});
		}
	}
	return { settings, warnings };
}
