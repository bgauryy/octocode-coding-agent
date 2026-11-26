import fs from "node:fs";
import path from "node:path";
import { getNativeDir } from "../../../config.ts";

const HEADING = "## Run children and use reports";
let cached: string | undefined;

/**
 * The `octocode-subagents` skill's rules for running children and reading their reports: one source for the skill and for
 * the main policy, which renders them itself when that skill cannot be loaded.
 */
export function childReportRules(): string {
	if (cached !== undefined) return cached;
	const file = path.join(getNativeDir(), "skills", "octocode-subagents", "SKILL.md");
	const text = fs.readFileSync(file, "utf8");
	const start = text.indexOf(`${HEADING}\n`);
	if (start < 0) throw new Error(`${file} has no "${HEADING}" section, which the main policy renders`);
	const body = text.slice(start + HEADING.length).replace(/^\n+/, "");
	const end = body.search(/^## /m);
	cached = (end < 0 ? body : body.slice(0, end)).trim();
	return cached;
}
