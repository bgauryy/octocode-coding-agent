import fs from "node:fs";
import path from "node:path";
import type { Sandbox } from "../e2e-real-process-harness.ts";

/** The harnesses that load only when `/harness` (the `toggles["harness:<id>"]` setting) switches them on. */
export type OptInHarness = "claude" | "codex" | "cursor";

/** The `toggles` setting that switches these harnesses on, for `SettingsManager.inMemory` or a settings file. */
export const harnessToggles = (...ids: OptInHarness[]): Record<string, boolean> =>
	Object.fromEntries(ids.map((id) => [`harness:${id}`, true]));

/** Switches harnesses on in the sandbox's global settings file, keeping the toggles and settings already there. */
export function enableHarnesses(box: Pick<Sandbox, "home">, ...ids: OptInHarness[]): void {
	const file = path.join(box.home, ".octocode", "octocodecode", "settings.json");
	const current = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
	const toggles = { ...(current.toggles as Record<string, boolean> | undefined), ...harnessToggles(...ids) };
	fs.writeFileSync(file, JSON.stringify({ ...current, toggles }));
}
