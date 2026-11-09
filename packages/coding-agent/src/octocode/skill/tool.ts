import { displayText, textResultDisplay } from "../render/display.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { expandClaudeArguments, expandClaudeVariables } from "../../core/claude-arguments.ts";
import type { ExtensionAPI } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { envFlag, SKILLS_IN_TASK_ENV } from "../../../../common/src/env.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import { repoKey } from "../../utils/git-repository.ts";
import { resultBlock, resultText } from "../render/tool.ts";
import { parseSkillBlock } from "../../core/agent-session/prompt-expansion.ts";
import { shortPath } from "../../utils/display-path.ts";
import { oneLine } from "../shared/text.ts";
import { timedTool, timingOf } from "../render/rows.ts";
import { textResult } from "../shared/util.ts";
import { type CatalogSkill, SkillCatalog, closeNames } from "./catalog.ts";
import { skillHeader, skillInstructions, skillLoadSummary, skillOrigin } from "./render.ts";
import { type SkillCategory, skillCategory } from "../../core/skills/category.ts";

/** Names listed when nothing is close to the requested one. */
const LISTED_NAMES = 20;

interface SkillDetails {
	name: string;
	location: string;
	baseDir: string;
	lines: number;
	/** Where the skill came from (`skillOrigin`), shown on the row. */
	origin?: string;
	/** Its listing group (`skillCategory`): core, octocode, workspace or global. */
	category?: SkillCategory;
	/** Its description as listed, shown above the instructions. */
	description?: string;
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

function body(entry: CatalogSkill, sessionId: string, cwd: string): string {
	const raw = stripFrontmatter(fs.readFileSync(entry.file, "utf8")).trim();
	const { skill } = entry;
	// The same expansion `/skill:name` does, without arguments: a Claude skill's `${CLAUDE_*}` values resolve here too.
	const text =
		skill.argumentStyle === "claude"
			? expandClaudeVariables(expandClaudeArguments(raw, "", [], skill.argumentNames), {
					sessionId,
					projectDir: repoKey(cwd).root,
					skillDir: path.dirname(entry.file),
					pluginRoot: skill.claudePluginRoot,
					pluginData: skill.claudePluginData,
				})
			: raw;
	return text;
}

/**
 * The `skill` tool: how a model loads a skill the session lists in `<available_skills>`. It reads only the instruction
 * file of a skill the session loaded and the user did not reserve (`disable-model-invocation`): a name outside that
 * catalog is refused, so the tool is no way to read another path. The result is the `/skill:name` block, with the
 * skill's directory so references in it resolve. With no loadable skill the tool's declaration stays out of requests.
 */
export function registerSkillTool(api: ExtensionAPI): SkillCatalog {
	const catalog = new SkillCatalog(() => api.getSkillResourceSnapshot());
	api.on("session_start", async () => {
		catalog.refresh();
	});
	api.registerTool(
		timedTool({
			name: "skill",
			label: "Skill",
			// The skills section owns the trigger; the snippet only points to it and this text says what the tool does.
			promptSnippet: renderInstruction("tools/skill/snippet.md"),
			description:
				"Load a skill's instructions by name and follow them. The result holds the skill's SKILL.md and its directory: " +
				"resolve relative paths in the instructions against that directory. Only listed skills load.",
			parameters: Type.Object({
				name: Type.String({ description: "Listed skill name" }),
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
				const all = catalog.refresh({ allowStale: false });
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
				let text: string;
				try {
					text = body(entry, ctx.sessionManager.getSessionId(), ctx.cwd);
				} catch (error) {
					throw new Error(`Skill "${skill.name}" could not be read: ${errorMessage(error)}`, { cause: error });
				}
				const lines = text.split("\n").length;
				const baseDir = path.dirname(entry.file);
				return textResult(
					`<skill name="${skill.name}" location="${entry.file}">\n${renderInstruction("system/skill-references.md", { dir: baseDir })}\n\n${text}\n</skill>`,
					{
						name: skill.name,
						location: entry.file,
						baseDir,
						lines,
						origin: skillOrigin(skill),
						category: skillCategory(skill),
						...(skill.description?.trim() ? { description: skill.description.trim() } : {}),
					} satisfies SkillDetails,
				);
			},
			display(input) {
				const name = typeof input.args?.name === "string" ? bareName(input.args.name) : "";
				const head = { title: name ? `Skill: ${name}` : "Skill", kind: "read" as const, blocks: [] };
				if (!input.result || input.status !== "completed") return textResultDisplay(head, input);
				const text = displayText(input.result);
				const details = input.result.details as Partial<SkillDetails> | undefined;
				const instructions = skillInstructions(parseSkillBlock(text)?.content ?? text);
				const lines = details?.lines ?? instructions.split("\n").length;
				return {
					...head,
					outcome: { text: skillLoadSummary({ ...details, lines }), tone: "muted" },
					blocks: [
						...(details?.description
							? [{ type: "text" as const, text: details.description, tone: "muted" as const }]
							: []),
						...(details?.location
							? [{ type: "path" as const, text: `file: ${details.location}`, label: "file", path: details.location }]
							: []),
						{ type: "markdown" as const, text: instructions },
					],
				};
			},
			renderCall(args, theme, context) {
				const name = typeof args?.name === "string" ? bareName(args.name) : "";
				return skillHeader(theme, context, name);
			},
			renderResult(result, _options, theme, context) {
				const text = resultText(result);
				// A validation failure lists what was wrong on the lines after its first: keep them all.
				if (context.isError) return resultBlock(theme, context, { summary: oneLine(text), body: "" });
				const details = result.details as Partial<SkillDetails> | undefined;
				// The row shows the instructions: the `<skill>` wrapper and its path preamble are for the model.
				const instructions = skillInstructions(parseSkillBlock(text)?.content ?? text);
				const lines = details?.lines ?? instructions.split("\n").length;
				// The collapsed row stays short enough for its expand hint; the expanded body opens with what the skill is for
				// and where its file is, then its instructions.
				const preface = [details?.description, details?.location ? shortPath(details.location) : undefined]
					.filter(Boolean)
					.map((line) => `${line}\n\n`)
					.join("");
				return resultBlock(theme, context, {
					summary: skillLoadSummary({ ...details, lines }),
					summaryColor: "customMessageText",
					body: `${preface}${instructions}`,
					max: 0,
					...timingOf(result.details),
				});
			},
		}),
	);
	return catalog;
}
