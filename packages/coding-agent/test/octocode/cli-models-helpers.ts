import fs from "node:fs";
import path from "node:path";
import { type Message, normalizeContext } from "@octocodeai/octocode-ai";
import { createRouteBackend } from "../../src/octocode/cli-models/backend.ts";
import type { CliModelRoute } from "../../src/octocode/cli-models/route.ts";
import type { RunnerState } from "../../src/octocode/external/runner-status.ts";
import { tmp } from "./helpers.ts";

/** A folder of executable stand-ins: `name` → shell body. */
export function bin(scripts: Record<string, string>): string {
	const dir = tmp("octocode-cli-models-bin-");
	for (const [name, body] of Object.entries(scripts))
		fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return dir;
}

/** An agent dir whose global settings.json holds `settings`, and a project folder whose own settings hold `project`. */
export function setup(settings: object, project?: object) {
	const agentDir = tmp("octocode-cli-models-agent-");
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
	const cwd = tmp("octocode-cli-models-cwd-");
	if (project) {
		fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".octocode", "settings.json"), JSON.stringify(project));
	}
	return { agentDir, cwd };
}

export const runner = (id: string): RunnerState => ({ id, name: id, cli: true, adapter: true, checkedAt: 1 });
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
export const ask = (route: CliModelRoute, text: string, signal?: AbortSignal) =>
	createRouteBackend(route)
		.provider.streamSimple(
			route.models[0],
			normalizeContext({ systemPrompt: "", messages: [user(text)] }),
			signal ? { signal } : {},
		)
		.result();
