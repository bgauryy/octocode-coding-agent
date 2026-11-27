import { isRecord } from "@octocodeai/octocode-contracts/guards";
import fs from "node:fs";
import { CLEANUP_DAYS_ENV, SESSION_RETENTION_DAYS_ENV } from "@octocodeai/octocode-common/env";
import { stripBom } from "@octocodeai/octocode-common/text";
import { getSettingsPath } from "../config.ts";

/** Days Octocode keeps its data; `0` keeps it forever. */
export interface Retention {
	/** Output, logs, scratch, session data, temp and database history. */
	days: number;
	/** Transcripts (session JSONL), with the session data and database rows that go with one. */
	sessionDays: number;
}

/** The `retention` setting with every default filled in: the two retention classes and the history archive window. */
export interface RetentionSettings extends Retention {
	/** Days after which history rows (audits, workspace commands) move from the database to the archive; at least 1. */
	archiveAfterDays: number;
}

export const RETENTION_DEFAULTS: Readonly<RetentionSettings> = { days: 30, sessionDays: 90, archiveAfterDays: 14 };

const FIELDS = [
	{ key: "days", env: CLEANUP_DAYS_ENV, min: 0, rule: "a whole number of days, 0 or more (0 keeps everything)" },
	{
		key: "sessionDays",
		env: SESSION_RETENTION_DAYS_ENV,
		min: 0,
		rule: "a whole number of days, 0 or more (0 keeps everything)",
	},
	{ key: "archiveAfterDays", env: undefined, min: 1, rule: "a whole number of days, 1 or more" },
] as const;

const isDays = (value: unknown, min: number): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= min;
/**
 * What is wrong with a settings file's `retention` value, one sentence each (none when it is absent or valid). The
 * settings loader queues these as warnings; `resolveRetention` ignores a bad value and uses the default.
 */
export function retentionProblems(value: unknown): string[] {
	if (value === undefined) return [];
	if (!isRecord(value))
		return [
			'Setting "retention" must be an object like { "days": 30, "sessionDays": 90, "archiveAfterDays": 14 }, so it does nothing.',
		];
	const problems = Object.keys(value)
		.filter((key) => !FIELDS.some((field) => field.key === key))
		.map((key) => `Setting "retention.${key}" is not a known setting, so it does nothing.`);
	for (const { key, min, rule } of FIELDS) {
		if (value[key] !== undefined && !isDays(value[key], min))
			problems.push(`Setting "retention.${key}" must be ${rule}; the default ${RETENTION_DEFAULTS[key]} applies.`);
	}
	return problems;
}

/**
 * The global `settings.json`, read without a SettingsManager (the sweep and prompt rendering run outside one). A file
 * that is missing, unreadable or not JSON yields undefined: the SettingsManager reports a broken file at startup, and
 * retention then follows the environment and the defaults.
 */
function globalSettings(): { retention?: unknown } | undefined {
	try {
		const parsed: unknown = JSON.parse(stripBom(fs.readFileSync(getSettingsPath(), "utf8")));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** The global `retention` object, or none when the file has no valid one. */
function configuredRetention(settings: { retention?: unknown } | undefined): Record<string, unknown> {
	return isRecord(settings?.retention) ? settings.retention : {};
}

/**
 * The one retention policy. Per field: the environment (`OCTOCODE_CLEANUP_DAYS` for `days`,
 * `OCTOCODE_SESSION_RETENTION_DAYS` for `sessionDays`; a non-negative integer, else ignored), then the global
 * `retention` setting, then the default (30 and 90). A project settings file cannot set it: one database and one home
 * serve every project. Pass `settings` to resolve against an already loaded global file; without it the file is read.
 */
export function resolveRetention(
	env: NodeJS.ProcessEnv = process.env,
	settings: { retention?: unknown } | undefined = globalSettings(),
): Retention {
	const configured = configuredRetention(settings);
	const pick = ({ key, env: name, min }: (typeof FIELDS)[0 | 1]): number => {
		const fromEnv = env[name]?.trim() ?? "";
		if (/^\d+$/.test(fromEnv) && Number.isSafeInteger(Number(fromEnv))) return Number(fromEnv);
		const fromSettings = configured[key];
		return isDays(fromSettings, min) ? fromSettings : RETENTION_DEFAULTS[key];
	};
	return { days: pick(FIELDS[0]), sessionDays: pick(FIELDS[1]) };
}

/**
 * The windows of the database's history housekeeping and of the archive readers: rows move to the archive after the
 * `retention.archiveAfterDays` setting (default 14, a whole number of 1 or more) and are dropped after `days` (`0` keeps
 * them). Both the scheduler and `archivedAudits` take this one value.
 */
export function historyWindows(
	env: NodeJS.ProcessEnv = process.env,
	settings: { retention?: unknown } | undefined = globalSettings(),
): { archiveAfterDays: number; keepDays: number } {
	const { key, min } = FIELDS[2];
	const configured = configuredRetention(settings)[key];
	return {
		archiveAfterDays: isDays(configured, min) ? configured : RETENTION_DEFAULTS.archiveAfterDays,
		keepDays: resolveRetention(env, settings).days,
	};
}
