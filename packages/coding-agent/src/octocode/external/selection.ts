import path from "node:path";
import { RUNNERS, runnerSpec } from "./runners.ts";

/** A configured selection names vendor CLIs, not aliases for another vendor's executable. */
export function selectedExternalAgent(
	selected: readonly string[] | undefined,
	vendor: string,
	command: string,
): boolean {
	if (selected === undefined) return true;
	if (!selected.includes(vendor)) return false;
	const name = path.win32.basename(path.basename(command)).replace(/\.(?:exe|cmd|bat)$/i, "");
	const known = RUNNERS.filter((runner) => [runner.cli, runner.adapter.command].includes(name));
	if (known.length > 0 && !known.some((runner) => runner.id === vendor)) return false;
	const spec = runnerSpec(vendor);
	return !spec || [spec.cli, spec.adapter.command].includes(name);
}
