import {
	constants,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { getSkillCommands } from "./skill-commands.ts";
import { isSyntheticPath } from "./source-info.ts";
import { explicitSkillIdentity, type ExplicitSkill, type LoadSkillsResult, type Skill } from "./skills.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RESOURCES = 4096;
const text = Type.String({ maxLength: 32768 });
const source = Type.Object(
	{
		path: text,
		source: text,
		scope: Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("temporary")]),
		origin: Type.Union([Type.Literal("package"), Type.Literal("top-level")]),
		baseDir: Type.Optional(text),
	},
	{ additionalProperties: false },
);
const skillSchema = Type.Object(
	{
		name: text,
		description: text,
		filePath: text,
		canonicalPath: Type.Optional(text),
		baseDir: text,
		sourceInfo: source,
		disableModelInvocation: Type.Boolean(),
		audience: Type.Optional(Type.Literal("coordinator")),
		userInvocable: Type.Optional(Type.Boolean()),
		triggers: Type.Optional(Type.Array(text, { maxItems: 64 })),
		argumentStyle: Type.Optional(Type.Literal("claude")),
		claudePluginRoot: Type.Optional(text),
		claudePluginData: Type.Optional(text),
		argumentNames: Type.Optional(Type.Array(text, { maxItems: 1024 })),
	},
	{ additionalProperties: false },
);
const validator = Compile(
	Type.Object(
		{
			version: Type.Literal(1),
			resources: Type.Array(
				Type.Object(
					{
						skill: skillSchema,
						canonicalPath: text,
						discoveryPath: text,
						visible: Type.Boolean(),
					},
					{ additionalProperties: false },
				),
				{ maxItems: MAX_RESOURCES },
			),
			explicitSkills: Type.Array(
				Type.Object(
					{
						resource: Type.Integer({ minimum: 0, maximum: MAX_RESOURCES - 1 }),
						name: text,
						promptByteLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BYTES })),
					},
					{ additionalProperties: false },
				),
				{ maxItems: MAX_RESOURCES },
			),
		},
		{ additionalProperties: false },
	),
);

export interface SkillResourceSnapshot {
	version: 1;
	resources: Array<{
		skill: Skill;
		canonicalPath: string;
		discoveryPath: string;
		visible: boolean;
	}>;
	explicitSkills: Array<{
		resource: number;
		name: ExplicitSkill["name"];
		promptByteLimit?: ExplicitSkill["promptByteLimit"];
	}>;
}

function validate(snapshot: unknown): asserts snapshot is SkillResourceSnapshot {
	if (!validator.Check(snapshot) || Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES)
		throw new Error("Invalid or oversized child skill resource snapshot");
	for (const resource of snapshot.resources) {
		const { skill, canonicalPath, discoveryPath } = resource;
		if (
			!isAbsolute(canonicalPath) ||
			(skill.canonicalPath !== undefined && skill.canonicalPath !== canonicalPath) ||
			!isAbsolute(discoveryPath) ||
			resolve(discoveryPath) !== resolve(skill.filePath) ||
			!isAbsolute(skill.baseDir) ||
			isSyntheticPath(skill.sourceInfo.path)
		)
			throw new Error("Invalid child skill resource identity");
		// A deleted or moved skill is dropped when the snapshot is adopted; a file that now resolves elsewhere is refused.
		if (!existsSync(canonicalPath)) continue;
		if (realpathSync(canonicalPath) !== canonicalPath || !statSync(canonicalPath).isFile())
			throw new Error("Child skill canonical identity changed");
	}
	const seen = new Set<string>();
	for (const entry of snapshot.explicitSkills) {
		const resource = snapshot.resources[entry.resource];
		if (
			!resource ||
			resource.skill.userInvocable === false ||
			resource.skill.argumentStyle === "claude" ||
			seen.has(resource.canonicalPath)
		)
			throw new Error("Invalid child explicit skill identity");
		seen.add(resource.canonicalPath);
	}
}

/** Deep-freeze a captured snapshot: one object is shared by every reader of its loader generation. */
function frozen<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) frozen(child);
	}
	return value;
}

/** The whole catalog's snapshot per loaded skill list: a loader reload makes a new list (and so a new snapshot). */
const whole = new WeakMap<
	readonly Skill[],
	{ explicit: LoadSkillsResult["explicitSkills"]; skills: number; identities: number; snapshot: SkillResourceSnapshot }
>();

/**
 * The snapshot of `available`, or of the skills `names` selects. The whole catalog's (no `names`) is validated once
 * per loaded skill list and then shared, frozen: the session asks for it before every model request. Whoever reads a
 * skill's file checks that file's identity then (`adoptSkillResourceSnapshot` validates again; the `skill` tool checks
 * the one file it reads).
 */
export function captureSkillResourceSnapshot(
	available: LoadSkillsResult,
	names?: readonly string[],
	commands: readonly SlashCommandInfo[] = [],
): SkillResourceSnapshot {
	if (names) return captureSnapshot(available, names, commands);
	const cached = whole.get(available.skills);
	if (
		cached &&
		cached.explicit === available.explicitSkills &&
		cached.skills === available.skills.length &&
		cached.identities === (available.explicitSkills?.length ?? -1)
	)
		return cached.snapshot;
	const snapshot = frozen(captureSnapshot(available, names, commands));
	whole.set(available.skills, {
		explicit: available.explicitSkills,
		skills: available.skills.length,
		identities: available.explicitSkills?.length ?? -1,
		snapshot,
	});
	return snapshot;
}

function captureSnapshot(
	available: LoadSkillsResult,
	names: readonly string[] | undefined,
	commands: readonly SlashCommandInfo[],
): SkillResourceSnapshot {
	let loaded = available;
	if (names?.length === 0) return { version: 1, resources: [], explicitSkills: [] };
	if (names) {
		const selected = selectSkills(loaded.skills, names, commands);
		loaded = {
			...loaded,
			skills: loaded.skills.filter((skill) => selected.has(skill)),
			explicitSkills: loaded.explicitSkills?.filter((identity) =>
				[...selected].some(
					(skill) =>
						skill === identity.skill ||
						(skill.name === identity.skill.name && skill.filePath === identity.skill.filePath),
				),
			),
		};
	}
	const snapshot: SkillResourceSnapshot = {
		version: 1,
		resources: [],
		explicitSkills: [],
	};
	const identities =
		loaded.explicitSkills ??
		loaded.skills.flatMap((skill) => {
			const identity = explicitSkillIdentity(skill);
			return identity ? [identity] : [];
		});
	const add = (skill: Skill, visible: boolean, captured?: ExplicitSkill): number => {
		if (isSyntheticPath(skill.filePath) || isSyntheticPath(skill.sourceInfo.path))
			throw new Error("Synthetic skills cannot be inherited by a child process");
		const identity =
			captured ??
			identities.find((candidate) => candidate.skill === skill) ??
			identities.find(
				(candidate) => candidate.skill.name === skill.name && candidate.skill.filePath === skill.filePath,
			);
		const discoveryPath = identity?.discoveryPath ?? resolve(skill.filePath);
		const canonicalPath = identity?.canonicalPath ?? skill.canonicalPath ?? realpathSync(discoveryPath);
		const prior = snapshot.resources.findIndex(
			(resource) => resource.discoveryPath === discoveryPath && resource.skill.name === skill.name,
		);
		if (prior >= 0) {
			snapshot.resources[prior].visible ||= visible;
			return prior;
		}
		snapshot.resources.push({
			skill: {
				...structuredClone(skill),
				filePath: discoveryPath,
				canonicalPath,
			},
			canonicalPath,
			discoveryPath,
			visible,
		});
		return snapshot.resources.length - 1;
	};
	for (const skill of loaded.skills) add(skill, true);
	for (const identity of identities) {
		const resource = add(identity.skill, false, identity);
		snapshot.explicitSkills.push({
			resource,
			name: identity.name,
			...(identity.promptByteLimit === undefined ? {} : { promptByteLimit: identity.promptByteLimit }),
		});
	}
	validate(snapshot);
	return snapshot;
}

export function adoptSkillResourceSnapshot(value: unknown): LoadSkillsResult {
	validate(value);
	const snapshot = structuredClone(value);
	const resources = snapshot.resources.map((resource) => ({
		...resource.skill,
		filePath: resource.canonicalPath,
		baseDir: dirname(resource.canonicalPath),
	}));
	const gone = new Set(
		snapshot.resources.flatMap((resource, index) => (existsSync(resource.canonicalPath) ? [] : [index])),
	);
	return {
		skills: snapshot.resources.flatMap((resource, index) =>
			resource.visible && !gone.has(index) ? [resources[index]] : [],
		),
		explicitSkills: snapshot.explicitSkills
			.filter((entry) => !gone.has(entry.resource))
			.map((entry) => ({
				skill: resources[entry.resource],
				name: entry.name,
				canonicalPath: snapshot.resources[entry.resource].canonicalPath,
				discoveryPath: snapshot.resources[entry.resource].discoveryPath,
				...(entry.promptByteLimit === undefined ? {} : { promptByteLimit: entry.promptByteLimit }),
			})),
		diagnostics: [...gone].map((index) => ({
			type: "warning" as const,
			message: "Inherited skill file no longer exists; the skill was not loaded",
			path: snapshot.resources[index].canonicalPath,
		})),
	};
}

function selectSkills(
	skills: readonly Skill[],
	names: readonly string[],
	commands: readonly SlashCommandInfo[],
): Set<Skill> {
	const skillCommands = getSkillCommands(
		skills,
		commands.filter((command) => command.source !== "skill"),
	);
	const selected = new Set<Skill>();
	for (const name of names) {
		const actual = commands.filter((command) => command.source === "skill" && command.name === name);
		const matches = skillCommands.filter((command) => command.name === name);
		if (actual.length !== 1 || matches.length !== 1 || actual[0].sourceInfo.path !== matches[0].skill.sourceInfo.path)
			throw new Error(`Unknown or ambiguous skill "${name}". Use a skill command name from the current session.`);
		// The child's model never lists such a skill, so selecting it would silently do nothing.
		if (matches[0].skill.disableModelInvocation)
			throw new Error(
				`Skill "${name}" sets disable-model-invocation, so a model cannot pass it to a subagent. Ask the user to run /${name}, or leave it out.`,
			);
		selected.add(matches[0].skill);
	}
	return selected;
}

export function readSkillResourceSnapshot(file: string): SkillResourceSnapshot {
	const before = lstatSync(file);
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("Invalid child skill snapshot file");
	const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stats = fstatSync(fd);
		if (
			!stats.isFile() ||
			stats.dev !== before.dev ||
			stats.ino !== before.ino ||
			(typeof process.getuid === "function" && stats.uid !== process.getuid()) ||
			(process.platform !== "win32" && (stats.mode & 0o077) !== 0)
		)
			throw new Error("Child skill snapshot must be a private owned file");
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const count = readSync(fd, buffer, size, buffer.length - size, null);
			if (!count) break;
			size += count;
		}
		if (size > MAX_BYTES) throw new Error("Child skill snapshot exceeds size limit");
		const snapshot: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
		validate(snapshot);
		return snapshot;
	} finally {
		closeSync(fd);
	}
}
