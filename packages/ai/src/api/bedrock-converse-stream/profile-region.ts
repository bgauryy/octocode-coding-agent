import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { BedrockOptions } from "./types.ts";

export function bedrockProfileRegion(options: BedrockOptions): string | undefined {
	const profile = options.profile || getProviderEnvValue("AWS_PROFILE", options.env) || "default";
	const path =
		getProviderEnvValue("AWS_CONFIG_FILE", options.env) ||
		join(getProviderEnvValue("HOME", options.env) || homedir(), ".aws", "config");
	let text: string;
	try {
		if (statSync(path).size > 1024 * 1024) return undefined;
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	let section = "";
	let region: string | undefined;
	const target = profile === "default" ? "default" : `profile ${profile}`;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/[;#].*$/, "").trim();
		if (!line) continue;
		const heading = line.match(/^\[([^\]]+)\]$/);
		if (heading) {
			section = heading[1].trim();
			continue;
		}
		const entry = line.match(/^([^=]+?)\s*=\s*(.*)$/);
		if (!entry || line.startsWith("[")) return undefined;
		if (section === target && entry[1].trim() === "region") {
			const value = entry[2].trim();
			if (!/^[a-z0-9-]+$/.test(value)) return undefined;
			region = value;
		}
	}
	return region;
}
