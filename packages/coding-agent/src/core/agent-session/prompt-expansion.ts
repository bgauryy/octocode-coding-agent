import { renderPrompt } from "../prompt-template.ts";
import { featureOfCommand, getBuiltinCommand, parseSlashCommand } from "../slash-commands.ts";
/**
 * Prompt input handling before a message is sent or queued: feature commands, `input` handlers,
 * skill commands, prompt templates, skill mentions and image normalization.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { ImageContent, Model, TextContent } from "@octocodeai/octocode-ai/compat";
import { repoKey } from "../../utils/git-repository.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import { processImage } from "../../utils/image-process.ts";
import { expandClaudeArguments, expandClaudeVariables } from "../claude-arguments.ts";
import type { FeatureHost, InputSource } from "../features/index.ts";
import { expandPromptTemplate, parseCommandArgs } from "../prompt-templates.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { getSkillCommands } from "../skill-commands.ts";
import { selectExplicitSkills } from "../skill-mentions.ts";
import { explicitSkillIdentity } from "../skills.ts";
import type { SessionInternals } from "./host.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { mapConcurrent } from "@octocodeai/octocode-common/map-concurrent";

/** Images prepared at once: each holds a decoded copy in a worker, so the bound caps peak memory. */
const IMAGE_PREPARATION_CONCURRENCY = 3;

// Skill Block Parsing
// ============================================================================

export { type ParsedSkillBlock, parseSkillBlock } from "../skill-block.ts";

export type ExpansionHost = Pick<SessionInternals, "session" | "cwd">;

/**
 * Try to execute a feature command. Returns true if command was found and executed, whether or not it succeeded;
 * `onFailure` hears a handler's failure, which is also emitted as a feature error.
 */
export async function tryExecuteFeatureCommand(
	runner: FeatureHost,
	text: string,
	onFailure?: (message: string) => void,
): Promise<boolean> {
	// Parse command name and args
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	let { name: commandName, args } = parsed;

	let command = runner.getCommand(commandName);
	if (!command) {
		// A retired form the terminal resolves to a built-in (`/mcp disable x` runs `/configuration`) still reaches its
		// own handler where that built-in is not available, so the handler can say where the command moved.
		const typed = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
		const typedCommand = typed && typed[1] !== commandName ? runner.getCommand(typed[1]) : undefined;
		if (typed && typedCommand) {
			commandName = typed[1];
			args = typed[2] ?? "";
			command = typedCommand;
		}
	}
	if (!command) {
		if (getBuiltinCommand(commandName)?.requiresNative) throw new Error(`/${commandName} requires native features.`);
		if (getBuiltinCommand(commandName))
			throw new Error(`/${commandName} is available in the interactive terminal only.`);
		const feature = featureOfCommand(commandName);
		if (feature) throw new Error(`/${commandName} is unavailable: the ${feature} feature is off.`);
		return false;
	}

	// Get command context from feature runner (includes session control methods)
	const ctx = runner.createCommandContext();

	try {
		await command.handler(args, ctx);
		return true;
	} catch (err) {
		runner.emitError({
			source: `command:${commandName}`,
			event: "command",
			error: errorMessage(err),
		});
		onFailure?.(errorMessage(err));
		return true;
	}
}

/**
 * Throw an error if the text is a feature command.
 */
export function throwIfFeatureCommand(runner: FeatureHost, text: string): void {
	const commandName = parseSlashCommand(text)?.name;
	if (!commandName) return;
	const command = runner.getCommand(commandName);

	if (command || getBuiltinCommand(commandName)) {
		throw new Error(`Command "/${commandName}" cannot be queued. Use prompt() or run the command when not streaming.`);
	}
}

export async function runInputHandlers(
	runner: FeatureHost,
	text: string,
	images: ImageContent[] | undefined,
	source: InputSource,
	streamingBehavior?: "steer" | "followUp",
): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
	if (!runner.hasHandlers("input")) {
		return { text, images };
	}

	const inputResult = await runner.emitInput(text, images, source, streamingBehavior);
	if (inputResult.action === "handled") {
		return undefined;
	}
	if (inputResult.action === "transform") {
		return { text: inputResult.text, images: inputResult.images ?? images };
	}
	return { text, images };
}

export async function normalizePromptImages(
	settingsManager: SettingsManager,
	limitsModel: Model<any> | undefined,
	images: ImageContent[] | undefined,
): Promise<{ images: ImageContent[]; hints: string[] }> {
	if (!images) return { images: [], hints: [] };

	const options = {
		autoResizeImages: settingsManager.getImageAutoResize(),
		resizeOptions: limitsModel?.inputLimits?.images?.resize,
	};
	// Each image resizes in its own worker thread, so independent images overlap; results keep prompt order.
	const results = await mapConcurrent(images, IMAGE_PREPARATION_CONCURRENCY, (image) =>
		processImage(Buffer.from(image.data, "base64"), image.mimeType, options),
	);
	const normalizedImages: ImageContent[] = [];
	const hints: string[] = [];
	for (const processed of results) {
		if (!processed.ok) {
			hints.push(processed.message);
			continue;
		}
		normalizedImages.push({
			type: "image",
			data: processed.data,
			mimeType: processed.mimeType,
		});
		hints.push(...processed.hints);
	}
	return { images: normalizedImages, hints };
}

/**
 * Expand direct and qualified skill commands to their full content.
 * Returns the expanded text, or the original text if not a skill command or skill not found.
 * Emits errors via feature runner if file read fails.
 */
function expandSkillCommand(host: ExpansionHost, text: string, expandedPaths?: Set<string>): string {
	if (!text.startsWith("/")) return text;

	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return text;
	const { session } = host;
	const [, name, rawArgs = ""] = match;
	const args = rawArgs.trim();
	const skills = session.resourceLoader.getSkills().skills;
	const commands = getSkillCommands(skills, [
		...session.featureHost.getRegisteredCommands(),
		...session.promptTemplates,
	]);
	const skill =
		commands.find((command) => command.name === name)?.skill ??
		(name.startsWith("skill:")
			? skills.find((candidate) => candidate.name === name.slice(6) && candidate.userInvocable !== false)
			: undefined);
	if (!skill) return text; // Unknown skill, pass through

	try {
		const filePath = skill.canonicalPath ?? skill.filePath;
		if (skill.canonicalPath && realpathSync(filePath) !== filePath)
			throw new Error("Skill canonical identity changed; reload skills before invoking it");
		const baseDir = skill.canonicalPath ? dirname(filePath) : skill.baseDir;
		const content = readFileSync(filePath, "utf-8");
		const identity = explicitSkillIdentity(skill);
		if (identity) expandedPaths?.add(identity.canonicalPath);
		const rawBody = stripFrontmatter(content).trim();
		const body =
			skill.argumentStyle === "claude"
				? expandClaudeVariables(
						expandClaudeArguments(rawBody, rawArgs, parseCommandArgs(rawArgs), skill.argumentNames),
						{
							sessionId: session.sessionManager.getSessionId(),
							projectDir: repoKey(host.cwd).root,
							skillDir: baseDir,
							pluginRoot: skill.claudePluginRoot,
							pluginData: skill.claudePluginData,
						},
					)
				: rawBody;
		const skillBlock = `<skill name="${skill.name}" location="${filePath}">\n${renderPrompt("system/skill-references.md", { dir: baseDir })}\n\n${body}\n</skill>`;
		return args && skill.argumentStyle !== "claude" ? `${skillBlock}\n\n${args}` : skillBlock;
	} catch (err) {
		// Emit error like feature commands do
		session.featureHost.emitError({
			source: skill.filePath,
			event: "skill_expansion",
			error: errorMessage(err),
		});
		return text; // Return original on error
	}
}

/** Expand skill commands (/skill:name args) and prompt templates (/template args). */
export function expandSkillInput(host: ExpansionHost, text: string): { text: string; expandedPaths: Set<string> } {
	const { session } = host;
	const expandedPaths = new Set<string>();
	let expanded = expandSkillCommand(host, text, expandedPaths);
	expanded = expandPromptTemplate(expanded, [...session.promptTemplates], session.featureHost.getRegisteredCommands(), {
		sessionId: session.sessionManager.getSessionId(),
		projectDir: repoKey(host.cwd).root,
	});
	return { text: expanded, expandedPaths };
}

/** The contents of skills the text mentions, except those a skill command already expanded. */
export function expandMentionSkills(host: ExpansionHost, text: string, expandedPaths: Set<string>): TextContent[] {
	const { session } = host;
	const fragments: TextContent[] = [];
	const loaded = session.resourceLoader.getSkills();
	const inventory =
		loaded.explicitSkills ??
		loaded.skills.flatMap((skill) => {
			const identity = explicitSkillIdentity(skill);
			return identity ? [identity] : [];
		});
	const selected = selectExplicitSkills(text, inventory);
	for (const identity of selected) {
		if (expandedPaths.has(identity.canonicalPath)) continue;
		try {
			if (realpathSync(identity.canonicalPath) !== identity.canonicalPath)
				throw new Error("Skill canonical identity changed; reload skills before invoking it");
			const bytes = readFileSync(identity.canonicalPath);
			let contents = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: true,
			}).decode(bytes);
			if (identity.promptByteLimit !== undefined && bytes.length > identity.promptByteLimit) {
				let end = identity.promptByteLimit;
				while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
				contents = bytes.subarray(0, end).toString("utf8");
				session.featureHost.emitError({
					source: identity.canonicalPath,
					event: "skill_expansion",
					error: `Skill ${identity.name} exceeded the main prompt context limit and was truncated.`,
				});
			}
			fragments.push({
				type: "text",
				text: `<skill>\n<name>${identity.name}</name>\n<path>${identity.canonicalPath}</path>\n${contents}\n</skill>`,
			});
		} catch (error) {
			session.featureHost.emitError({
				source: identity.canonicalPath,
				event: "skill_expansion",
				error: errorMessage(error),
			});
		}
	}
	return fragments;
}
