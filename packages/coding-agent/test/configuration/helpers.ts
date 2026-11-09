import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { createConfiguration } from "../../src/configuration/index.ts";
import type { ConfigContext, ConfigLiveHooks } from "../../src/configuration/index.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { Sandbox } from "../discovery/fixtures.ts";

export function context(sandbox: Sandbox, options: { trusted?: boolean; live?: ConfigLiveHooks } = {}): ConfigContext {
	const projectTrusted = options.trusted ?? true;
	return {
		cwd: sandbox.cwd,
		agentDir: sandbox.agentDir,
		home: sandbox.home,
		projectTrusted,
		settings: SettingsManager.create(sandbox.cwd, sandbox.agentDir, { projectTrusted }),
		...(options.live ? { live: options.live } : {}),
	};
}

export const configuration = (sandbox: Sandbox, options: { trusted?: boolean; live?: ConfigLiveHooks } = {}) =>
	createConfiguration(context(sandbox, options));

export const globalSettingsFile = (sandbox: Sandbox) => join(sandbox.agentDir, "settings.json");
export const projectSettingsFile = (sandbox: Sandbox) => join(sandbox.cwd, CONFIG_DIR_NAME, "settings.json");

export function readJson(file: string): Record<string, any> | undefined {
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, any>) : undefined;
}
