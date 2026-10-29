import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalPath } from "../../src/octocode/shared/home/repo.ts";
import { agentScratch, scratchNames, scratchRoot, sweepScratch } from "../../src/octocode/subagents/handoff/scratch.ts";
import { DAY_MS } from "../../src/octocode/shared/util.ts";
import { tmp } from "./helpers.ts";

/** A finished child's scratch folder: its transcript in `session/` and its report, all written `ageDays` ago unless `fresh` names one written now. */
function scratchFolder(root: string, id: string, ageDays: number, fresh?: "transcript" | "report"): string {
	const dir = path.join(root, id);
	const session = path.join(dir, "session");
	fs.mkdirSync(session, { recursive: true });
	const transcript = path.join(session, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	const report = path.join(dir, "report.md");
	fs.writeFileSync(transcript, "{}\n");
	fs.writeFileSync(report, "done: report\n");
	const old = new Date(Date.now() - ageDays * DAY_MS);
	for (const file of [transcript, report, session, dir]) fs.utimesSync(file, old, old);
	const now = new Date();
	if (fresh === "transcript") fs.utimesSync(transcript, now, now);
	if (fresh === "report") fs.utimesSync(report, now, now);
	return dir;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the subagent scratch sweep", () => {
	it("sweeps and names the folders under the team workspace the scratch folders are written to", async () => {
		const cwd = tmp("octocode-scratch-cwd-");
		const team = tmp("octocode-scratch-team-");
		vi.stubEnv("OCTOCODE_TEAM_WORKSPACE", team);
		const dir = agentScratch(cwd, "general-team")!;
		expect(canonicalPath(path.dirname(dir))).toBe(canonicalPath(scratchRoot(cwd)));
		expect(scratchNames(cwd)).toContain("general-team");
		const old = new Date(Date.now() - 40 * DAY_MS);
		fs.rmSync(path.join(dir, ".owner"));
		fs.utimesSync(dir, old, old);
		await sweepScratch(scratchRoot(cwd), {});
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("keeps a folder whose transcript or report was written recently, though the folder itself is old", async () => {
		const root = tmp("octocode-scratch-");
		const active = scratchFolder(root, "general-active", 8, "transcript");
		const reported = scratchFolder(root, "general-reported", 8, "report");
		const idle = scratchFolder(root, "general-idle", 8);
		await sweepScratch(root, { OCTOCODE_CLEANUP_DAYS: "7" });
		expect(fs.existsSync(active)).toBe(true);
		expect(fs.existsSync(reported)).toBe(true);
		expect(fs.existsSync(idle)).toBe(false);
	});

	it("follows OCTOCODE_CLEANUP_DAYS: 0 keeps every folder, a longer period keeps an 8-day-old one", async () => {
		const root = tmp("octocode-scratch-");
		const old = scratchFolder(root, "general-old", 40);
		await sweepScratch(root, { OCTOCODE_CLEANUP_DAYS: "0" });
		expect(fs.existsSync(old)).toBe(true);
		const week = scratchFolder(root, "general-week", 8);
		await sweepScratch(root, { OCTOCODE_CLEANUP_DAYS: "10" });
		expect(fs.existsSync(week)).toBe(true);
		expect(fs.existsSync(old)).toBe(false);
	});

	it("keeps a folder as long as the session sweep keeps output by default (30 days)", async () => {
		const root = tmp("octocode-scratch-");
		const recent = scratchFolder(root, "general-recent", 8);
		const stale = scratchFolder(root, "general-stale", 31);
		await sweepScratch(root, {});
		expect(fs.existsSync(recent)).toBe(true);
		expect(fs.existsSync(stale)).toBe(false);
	});
});
