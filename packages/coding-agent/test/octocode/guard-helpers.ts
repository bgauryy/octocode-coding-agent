import os from "node:os";
import { loadMcpConfig, type McpServerEntry } from "../../../mcp/src/api.ts";
import { getAgentDir } from "../../src/config.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { SkillReviewInput } from "../../src/core/skill-review.ts";
import { skillItem } from "../../src/octocode/guard/items.ts";
import { knownReviews, resetGateRecords } from "../../src/octocode/guard/registry.ts";
import { decide, type GuardOptions, resolveReviews, scopeFor } from "../../src/octocode/guard/store.ts";
import type { ReviewItem } from "../../src/octocode/guard/types.ts";
import { loadHooks } from "../../src/octocode/hooks/config.ts";
import { hookReviewItems } from "../../src/octocode/hooks/review.ts";
import { mcpReviewItems } from "../../src/octocode/mcp-host/review.ts";

/**
 * Fixture opt-in for the security review: approves items as the user does in /security, through the guard's own
 * records (the agent database the environment names). Call after the fixture files are written: an approval pins their
 * current content, so a later edit turns the item off again.
 */

function approve(items: readonly ReviewItem[], guard: GuardOptions = {}): number {
	const reviews = resolveReviews(items, guard);
	for (const review of reviews) decide(review, "approved", "test", guard);
	return reviews.length;
}

/** Approves only the named synthetic skill files at their current contents, including explicit or extension paths. */
export function approveFixtureSkillFiles(
	skills: readonly SkillReviewInput[],
	cwd: string,
	guard: GuardOptions = {},
): number {
	return approve(
		skills.map((skill) =>
			skillItem({
				name: skill.name,
				filePath: skill.filePath,
				scope: skill.category === "workspace" ? scopeFor(skill.filePath, cwd) : "global",
			}),
		),
		guard,
	);
}

/** Approves every hook a session in `cwd` would load. */
export function approveFixtureHooks(
	cwd: string,
	home: string = os.homedir(),
	options: { plugins?: Settings["plugins"]; toggles?: Settings["toggles"]; guard?: GuardOptions } = {},
): number {
	const { guard, ...load } = options;
	const { config } = loadHooks(cwd, true, home, load);
	return approve([...hookReviewItems(config, cwd, home).values()], guard);
}

/** Approves every configured MCP server a session in `cwd` would see (built-in servers are never reviewed). */
export function approveFixtureMcp(
	cwd: string,
	agentDir: string = getAgentDir(),
	defaults: readonly McpServerEntry[] = [],
	guard: GuardOptions = {},
): number {
	const { servers } = loadMcpConfig({ agentDir, cwd, projectTrusted: true, defaults });
	return approve(
		mcpReviewItems(
			servers.filter((entry) => entry.scope !== "default"),
			cwd,
		),
		guard,
	);
}

/** Approves every workspace and global skill a session in `cwd` would load. */
export async function approveFixtureSkills(
	cwd: string,
	agentDir: string = getAgentDir(),
	guard: GuardOptions = {},
): Promise<number> {
	resetGateRecords();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	await new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noThemes: true,
		noContextFiles: true,
	}).loadSkillsOnly();
	return approve(
		knownReviews()
			.filter((review) => review.item.kind === "skill")
			.map((review) => review.item),
		guard,
	);
}
