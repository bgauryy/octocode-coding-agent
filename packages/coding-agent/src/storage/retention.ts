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

export const RETENTION_DEFAULTS: Readonly<Retention> = { days: 30, sessionDays: 90 };

const FIELDS = [
	{ key: "days", env: CLEANUP_DAYS_ENV },
	{ key: "sessionDays", env: SESSION_RETENTION_DAYS_ENV },
] as const;

const isDays = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/**
 * What is wrong with a settings file's `retention` value, one sentence each (none when it is absent or valid). The
 * settings loader queues these as warnings; `resolveRetention` ignores a bad value and uses the default.
 */
export function retentionProblems(value: unknown): string[] {
	if (value === undefined) return [];
	if (!isRecord(value))
		return ['Setting "retention" must be an object like { "days": 30, "sessionDays": 90 }, so it does nothing.'];
	const problems = Object.keys(value)
		.filter((key) => !FIELDS.some((field) => field.key === key))
		.map((key) => `Setting "retention.${key}" is not a known setting, so it does nothing.`);
	for (const { key } of FIELDS) {
		if (value[key] !== undefined && !isDays(value[key]))
			problems.push(
				`Setting "retention.${key}" must be a whole number of days, 0 or more (0 keeps everything); the default ${RETENTION_DEFAULTS[key]} applies.`,
			);
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
	const configured = isRecord(settings?.retention) ? settings.retention : {};
	const pick = ({ key, env: name }: (typeof FIELDS)[number]): number => {
		const fromEnv = env[name]?.trim() ?? "";
		if (/^\d+$/.test(fromEnv) && Number.isSafeInteger(Number(fromEnv))) return Number(fromEnv);
		const fromSettings = configured[key];
		return isDays(fromSettings) ? fromSettings : RETENTION_DEFAULTS[key];
	};
	return { days: pick(FIELDS[0]), sessionDays: pick(FIELDS[1]) };
}

/**
 * The windows of the database's history housekeeping and of the archive readers: rows move to the archive after 14
 * days and are dropped after `days` (`0` keeps them). Both the scheduler and `archivedAudits` take this one value.
 */
export function historyWindows(env: NodeJS.ProcessEnv = process.env): { archiveAfterDays: number; keepDays: number } {
	return { archiveAfterDays: 14, keepDays: resolveRetention(env).days };
}
