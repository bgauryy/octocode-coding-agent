import fs from "node:fs";
import { Type } from "typebox";
import { expandClaudeArguments, expandClaudeVariables } from "../../core/claude-arguments.ts";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { errorMessage } from "../../utils/guards.ts";
import { envFlag, SKILLS_IN_TASK_ENV } from "../shared/env.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import { repoKey } from "../shared/home/repo.ts";
import { resultBlock, resultText } from "../shared/render.ts";
import { plural } from "../shared/render/text.ts";
import { timedTool, timingOf } from "../shared/render/rows.ts";
import { textResult } from "../shared/util.ts";
import { type CatalogSkill, SkillCatalog, closeNames, setActiveSkillCatalog } from "./catalog.ts";
import { skillHeader } from "./render.ts";

/** A skill's instructions are read whole up to this size; a larger file is cut and says so. */
const MAX_SKILL_BYTES = 256 * 1024;
/** Names listed when nothing is close to the requested one. */
const LISTED_NAMES = 20;

interface SkillDetails {
	name: string;
	location: string;
	baseDir: string;
	lines: number;
	truncated?: boolean;
}

/** `skill:name`, `/skill:name` and `/name` name the same skill as `name`: the forms users type. */
const bareName = (value: string): string => value.trim().replace(/^\/?(?:skill:)?/, "");

function unknownSkill(name: string, available: readonly CatalogSkill[]): Error {
	const names = available.map((entry) => entry.skill.name);
	if (names.length === 0)
		return new Error(`Unknown skill "${name}": this session has no skill a model can load. Continue without one.`);
	const close = closeNames(name, names);
	return new Error(
		close.length > 0
			? `Unknown skill "${name}". Close matches: ${close.join(", ")}.`
			: `Unknown skill "${name}". Available: ${names.slice(0, LISTED_NAMES).join(", ")}${names.length > LISTED_NAMES ? `, and ${names.length - LISTED_NAMES} more` : ""}.`,
	);
}

function body(entry: CatalogSkill, sessionId: string, cwd: string): { text: string; truncated: boolean } {
	const bytes = fs.readFileSync(entry.file);
	const truncated = bytes.length > MAX_SKILL_BYTES;
	let end = Math.min(bytes.length, MAX_SKILL_BYTES);
	// Never cut inside a UTF-8 sequence.
	while (truncated && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	const raw = stripFrontmatter(bytes.subarray(0, end).toString("utf8")).trim();
	const { skill } = entry;
	// The same expansion `/skill:name` does, without arguments: a Claude skill's `${CLAUDE_*}` values resolve here too.
	const text =
		skill.argumentStyle === "claude"
			? expandClaudeVariables(expandClaudeArguments(raw, "", [], skill.argumentNames), {
					sessionId,
					projectDir: repoKey(cwd).root,
					skillDir: skill.baseDir,
					pluginRoot: skill.claudePluginRoot,
					pluginData: skill.claudePluginData,
				})
			: raw;
	return { text, truncated };
}

/**
 * The `skill` tool: how a model loads a skill the session lists in `<available_skills>`. It reads only the instruction
 * file of a skill the session loaded and the user did not reserve (`disable-model-invocation`): a name outside that
 * catalog is refused, so the tool is no way to read another path. The result is the `/skill:name` block, with the
 * skill's directory so references in it resolve. With no loadable skill the tool's declaration stays out of requests.
 */
export function registerSkillTool(api: ExtensionAPI): SkillCatalog {
	const catalog = new SkillCatalog(() => api.getSkillResourceSnapshot());
	setActiveSkillCatalog(catalog);
	api.on("session_start", async () => {
		catalog.refresh();
	});
	api.on("session_shutdown", async () => {
		setActiveSkillCatalog(undefined, catalog);
	});
	api.registerTool(
		timedTool({
			name: "skill",
			label: "Skill",
			description:
				"Load a skill's instructions by name. Call it before starting a task when the task matches the description of a skill " +
				"listed in <available_skills>, then follow it; do not call it for a skill that does not match. The result holds the skill's " +
				"SKILL.md and its directory: resolve relative paths in the instructions against that directory. Only listed skills load.",
			promptSnippet: "Load a listed skill's instructions when the task matches its description",
			parameters: Type.Object({
				name: Type.String({ description: "The skill's name, as listed in <available_skills>" }),
			}),
			// The declaration is worth its tokens only when a model can load a skill. A child whose skills ride in its task
			// keeps it even without any: siblings with and without skills then send the same tool list and share its cache.
			prepareLoadout: () =>
				catalog.invocable().length === 0 && !envFlag(process.env, SKILLS_IN_TASK_ENV)
					? { hiddenDeclarations: ["skill"] }
					: undefined,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				const requested = bareName(params.name ?? "");
				if (!requested) throw new Error("skill needs the name of a listed skill.");
				const all = catalog.refresh();
				const entry =
					all.find((candidate) => candidate.skill.name === requested) ??
					all.find((candidate) => candidate.skill.name.toLowerCase() === requested.toLowerCase());
				if (!entry)
					throw unknownSkill(
						requested,
						all.filter((candidate) => !candidate.skill.disableModelInvocation),
					);
				const { skill } = entry;
				if (skill.disableModelInvocation)
					throw new Error(
						`Skill "${skill.name}" is reserved for the user (disable-model-invocation); do not load it. Ask the user to run /skill:${skill.name} if it is needed.`,
					);
				let loaded: ReturnType<typeof body>;
				try {
					loaded = body(entry, ctx.sessionManager.getSessionId(), ctx.cwd);
				} catch (error) {
					throw new Error(`Skill "${skill.name}" could not be read: ${errorMessage(error)}`);
				}
				const lines = loaded.text.split("\n").length;
				const cut = loaded.truncated
					? `\n\n[Cut at ${MAX_SKILL_BYTES / 1024} KB. Read the rest of ${skill.filePath} with a file reader.]`
					: "";
				return textResult(
					`<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${loaded.text}${cut}\n</skill>`,
					{
						name: skill.name,
						location: skill.filePath,
						baseDir: skill.baseDir,
						lines,
						...(loaded.truncated ? { truncated: true } : {}),
					} satisfies SkillDetails,
				);
			},
			renderCall(args, theme, context) {
				const name = typeof args?.name === "string" ? bareName(args.name) : "";
				return skillHeader(theme, context, name);
			},
			renderResult(result, _options, theme, context) {
				const text = resultText(result);
				if (context.isError) return resultBlock(theme, context, { summary: text.split("\n")[0], body: "" });
				const details = result.details as Partial<SkillDetails> | undefined;
				const lines = details?.lines ?? text.split("\n").length;
				return resultBlock(theme, context, {
					summary: `Loaded ${plural(lines, "line")}`,
					summaryColor: "customMessageText",
					body: text,
					max: 0,
					...timingOf(result.details),
				});
			},
		}),
	);
	return catalog;
}
