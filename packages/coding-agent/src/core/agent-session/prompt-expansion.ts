import { getBuiltinCommand, parseSlashCommand } from "../slash-commands.ts";
/**
 * Prompt input handling before a message is sent or queued: extension commands, `input` handlers,
 * skill commands, prompt templates, skill mentions and image normalization.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { ImageContent, Model, TextContent } from "@octocodeai/octocode-ai/compat";
import { repoKey } from "../../octocode/shared/home/repo.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import { processImage } from "../../utils/image-process.ts";
import { expandClaudeArguments, expandClaudeVariables } from "../claude-arguments.ts";
import type { ExtensionRunner, InputSource } from "../extensions/index.ts";
import { expandPromptTemplate, parseCommandArgs } from "../prompt-templates.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { getSkillCommands } from "../skill-commands.ts";
import { selectExplicitSkills } from "../skill-mentions.ts";
import { explicitSkillIdentity } from "../skills.ts";
import type { SessionInternals } from "./host.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

export type ExpansionHost = Pick<SessionInternals, "session" | "cwd">;

/**
 * Try to execute an extension command. Returns true if command was found and executed.
 */
export async function tryExecuteExtensionCommand(runner: ExtensionRunner, text: string): Promise<boolean> {
	// Parse command name and args
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	const { name: commandName, args } = parsed;

	const command = runner.getCommand(commandName);
	if (!command) {
		if (getBuiltinCommand(commandName)?.requiresNative) throw new Error(`/${commandName} requires native features.`);
		if (getBuiltinCommand(commandName))
			throw new Error(`/${commandName} is available in the interactive terminal only.`);
		return false;
	}

	// Get command context from extension runner (includes session control methods)
	const ctx = runner.createCommandContext();

	try {
		await command.handler(args, ctx);
		return true;
	} catch (err) {
		// Emit error via extension runner
		runner.emitError({
			extensionPath: `command:${commandName}`,
			event: "command",
			error: errorMessage(err),
		});
		return true;
	}
}

/**
 * Throw an error if the text is an extension command.
 */
export function throwIfExtensionCommand(runner: ExtensionRunner, text: string): void {
	const commandName = parseSlashCommand(text)?.name;
	if (!commandName) return;
	const command = runner.getCommand(commandName);

	if (command || getBuiltinCommand(commandName)) {
		throw new Error(`Command "/${commandName}" cannot be queued. Use prompt() or run the command when not streaming.`);
	}
}

export async function runInputHandlers(
	runner: ExtensionRunner,
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

	const normalizedImages: ImageContent[] = [];
	const hints: string[] = [];
	for (const image of images) {
		const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
			autoResizeImages: settingsManager.getImageAutoResize(),
			resizeOptions: limitsModel?.inputLimits?.images?.resize,
		});
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
 * Emits errors via extension runner if file read fails.
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
		...session.extensionRunner.getRegisteredCommands(),
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
		const skillBlock = `<skill name="${skill.name}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
		return args && skill.argumentStyle !== "claude" ? `${skillBlock}\n\n${args}` : skillBlock;
	} catch (err) {
		// Emit error like extension commands do
		session.extensionRunner.emitError({
			extensionPath: skill.filePath,
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
	expanded = expandPromptTemplate(
		expanded,
		[...session.promptTemplates],
		session.extensionRunner.getRegisteredCommands(),
		{
			sessionId: session.sessionManager.getSessionId(),
			projectDir: repoKey(host.cwd).root,
		},
	);
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
				session.extensionRunner.emitError({
					extensionPath: identity.canonicalPath,
					event: "skill_expansion",
					error: `Skill ${identity.name} exceeded the main prompt context limit and was truncated.`,
				});
			}
			fragments.push({
				type: "text",
				text: `<skill>\n<name>${identity.name}</name>\n<path>${identity.canonicalPath}</path>\n${contents}\n</skill>`,
			});
		} catch (error) {
			session.extensionRunner.emitError({
				extensionPath: identity.canonicalPath,
				event: "skill_expansion",
				error: errorMessage(error),
			});
		}
	}
	return fragments;
}
