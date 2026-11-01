import "../mcp-host.ts";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServerEntry } from "../../../mcp/src/config.ts";
import { prepareOctocodeSkillLaunch } from "../../../mcp/src/presets/octocode/skill-paths.ts";
import { tmp } from "./helpers.ts";

const entry = (env?: Record<string, string>): McpServerEntry => ({
	name: "octocode",
	source: "mcp.json",
	config: { command: "octocode-mcp", ...(env ? { env } : {}) },
});

describe("configured Octocode skill roots", () => {
	it("adds canonical loaded skill roots and preserves configuration without mutating it", () => {
		const dir = tmp();
		const skill = path.join(dir, "skill");
		fs.mkdirSync(skill);
		fs.writeFileSync(path.join(skill, "SKILL.md"), "instructions");
		const directories = [fs.realpathSync(skill), fs.realpathSync(skill)];
		const canonical = fs.realpathSync(skill);
		const original = entry({ KEEP: "value", WORKSPACE_ROOT: "/explicit/workspace" });
		const prepared = prepareOctocodeSkillLaunch(original, dir, directories, { OCTOCODE_HOME: "/native/home" });
		expect(prepared.config).toMatchObject({
			env: {
				KEEP: "value",
				WORKSPACE_ROOT: "/explicit/workspace",
				ALLOWED_PATHS: `${dir},/native/home/agent/sessions,${canonical}`,
			},
		});
		expect(original.config).toEqual({
			command: "octocode-mcp",
			env: { KEEP: "value", WORKSPACE_ROOT: "/explicit/workspace" },
		});
	});

	it.each(["/restricted", ""])("preserves an explicit ALLOWED_PATHS in the entry's own env %j", (allowed) => {
		const configured = entry({ ALLOWED_PATHS: allowed });
		expect(prepareOctocodeSkillLaunch(configured, "/workspace", [], {})).toBe(configured);
	});

	it("adds the inherited ALLOWED_PATHS to the automatic roots instead of replacing them", () => {
		const extra = fs.mkdtempSync(path.join(tmp(), "extra-"));
		const prepared = prepareOctocodeSkillLaunch(entry(), "/workspace", [], {
			ALLOWED_PATHS: extra,
			OCTOCODE_HOME: "/native/home",
		});
		const allowed = (prepared.config as unknown as { env: { ALLOWED_PATHS: string } }).env.ALLOWED_PATHS.split(",");
		expect(allowed.slice(0, 2)).toEqual(["/workspace", "/native/home/agent/sessions"]);
		expect(allowed).toContain(fs.realpathSync(extra));
	});

	it("leaves HTTP and unrelated local servers untouched", () => {
		const http: McpServerEntry = { name: "octocode", source: "test", config: { url: "https://example.com/mcp" } };
		const other = { ...entry(), name: "other" };
		expect(prepareOctocodeSkillLaunch(http, "/workspace", [], {})).toBe(http);
		expect(prepareOctocodeSkillLaunch(other, "/workspace", [], {})).toBe(other);
	});
});
