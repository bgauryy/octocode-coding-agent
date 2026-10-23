import os from "node:os";
import type { ExtensionAPI, ExtensionContext, ToolInvocation } from "../../core/extensions/types.ts";
import { nativeHost } from "../shared/host-api.ts";
import { claudeSettingsSources } from "../shared/home.ts";
import { envFlag, HOOKS_COMPAT_ENV } from "../shared/env.ts";
import { projectTrustForContents, preparePermissionTrustUpdate } from "../shared/trust.ts";
import { say } from "../shared/commands.ts";
import { errorMessage } from "../shared/util.ts";
import { initializeBashSyntax } from "./bash-syntax.ts";
import {
	evaluateSourcePolicy,
	unprojectedSourcePolicy,
	parseSourcePolicy,
	sourceToolDenied,
	type SourcePolicy,
} from "./source-policy.ts";
import {
	applySessionRuleUpdates,
	type SourcePermissionUpdate,
	type SourceRuleArrays,
} from "../shared/permission-updates.ts";
import {
	localPermissionAllowances,
	readPolicy,
	stageSettingsWrite,
	persistSettingsWrite,
} from "./source-policy-storage.ts";

export function registerSourcePolicy(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv = process.env,
	home = os.homedir(),
	onChange?: () => void,
) {
	let policy: SourcePolicy = { rules: [], errors: [] };
	let basePolicy: SourcePolicy = { rules: [], errors: [] };
	let last = "";
	let sessionId: string | undefined;
	let sessionRules: SourceRuleArrays = { allow: [], deny: [], ask: [] };
	let transient: SourcePolicy = { rules: [], errors: [] };
	let revision = 0;
	const enabled = envFlag(env, HOOKS_COMPAT_ENV);
	const sessionSource = (ctx: ExtensionContext) => ({
		path: "Claude session permission updates",
		anchor: ctx.cwd,
	});
	const publish = (ctx: ExtensionContext) => {
		const overlay = parseSourcePolicy({ permissions: sessionRules }, sessionSource(ctx));
		policy = {
			rules: [...basePolicy.rules, ...transient.rules, ...overlay.rules],
			errors: [...basePolicy.errors, ...transient.errors, ...overlay.errors],
			defaultMode: overlay.defaultMode ?? transient.defaultMode ?? basePolicy.defaultMode,
			additionalDirectories: [
				...(basePolicy.additionalDirectories ?? []),
				...(transient.additionalDirectories ?? []),
				...(overlay.additionalDirectories ?? []),
			],
		};
		revision++;
		onChange?.();
		nativeHost(pi).setToolPolicy?.((name) => !sourceToolDenied(policy, name));
	};
	const capture = async (ctx: ExtensionContext) => {
		try {
			await initializeBashSyntax();
		} catch {
			say(ctx, "Bash syntax parser unavailable; shell file targets require explicit review", "warning");
		}
		// Read the policy only after initialization, and verify trust against exactly those bytes.
		const allSources = claudeSettingsSources(ctx.cwd, true, home);
		const captured = allSources.map((source) => ({
			source,
			...readPolicy(source.path),
		}));
		const trusted = await projectTrustForContents(
			ctx,
			new Map(
				captured.slice(1).flatMap((entry) => (entry.text === undefined ? [] : [[entry.source.path, entry.text]])),
			),
		);
		const current = allSources.map((source) => ({
			source,
			...readPolicy(source.path),
		}));
		const stable = JSON.stringify(captured) === JSON.stringify(current);
		const contents = captured.map((entry) =>
			stable || entry.source === allSources[0] ? entry : { source: entry.source, error: true },
		);
		const localAllowed = contents.map((entry) => !entry.error && localPermissionAllowances(entry.source.path));
		const id = ctx.sessionManager.getSessionId();
		const fingerprint = JSON.stringify({
			contents,
			trusted,
			localAllowed,
			sessionId: id,
		});
		const next: SourcePolicy = { rules: [], errors: [] };
		for (const [index, { source, text, error }] of contents.entries()) {
			if (text === undefined && !error) continue;
			let loaded: SourcePolicy;
			try {
				loaded = parseSourcePolicy(JSON.parse(text!), source);
			} catch {
				loaded = parseSourcePolicy({ permissions: null }, source);
			}
			next.rules.push(
				...loaded.rules.filter(
					(rule) => trusted || source.path === allSources[0].path || localAllowed[index] || rule.behavior !== "allow",
				),
			);
			next.errors.push(...loaded.errors);
			if (loaded.defaultMode) next.defaultMode = loaded.defaultMode;
			if (trusted || source.path === allSources[0].path || localAllowed[index])
				next.additionalDirectories = [...(next.additionalDirectories ?? []), ...(loaded.additionalDirectories ?? [])];
		}
		return { fingerprint, next, id, contents };
	};
	let acceptedContents: Awaited<ReturnType<typeof capture>>["contents"] = [];
	const install = (snapshot: Awaited<ReturnType<typeof capture>>) => {
		if (sessionId !== snapshot.id) {
			sessionId = snapshot.id;
			sessionRules = { allow: [], deny: [], ask: [] };
			transient = { rules: [], errors: [] };
		}
		basePolicy = snapshot.next;
		last = snapshot.fingerprint;
		acceptedContents = snapshot.contents;
	};
	const load = async (ctx: ExtensionContext) => {
		if (!enabled) return;
		const snapshot = await capture(ctx);
		if (snapshot.fingerprint === last) return;
		install(snapshot);
		publish(ctx);
		if (policy.errors.length) say(ctx, policy.errors.join("\n"), "warning");
	};
	let pending: Promise<void> = Promise.resolve();
	const refresh = (ctx: ExtensionContext) => {
		const current = pending.then(() => load(ctx));
		pending = current.catch(() => {});
		return current;
	};
	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("before_agent_start", async (_event, ctx) => {
		await refresh(ctx);
	});
	return {
		prepareUpdates: (ctx: ExtensionContext, updates: readonly SourcePermissionUpdate[]) => {
			if (!enabled) throw new Error("Source permission updates require compatibility mode");
			const nextSession = applySessionRuleUpdates(
				sessionRules,
				updates.filter((update) => update.destination === "session"),
			);
			const sessionParsed = parseSourcePolicy({ permissions: nextSession }, sessionSource(ctx));
			if (sessionParsed.errors.length) throw new Error(sessionParsed.errors.join("\n"));
			const sources = claudeSettingsSources(ctx.cwd, true, home);
			const destinations = {
				userSettings: sources[0],
				projectSettings: sources[1],
				localSettings: sources[2],
			};
			const plans = (["userSettings", "projectSettings", "localSettings"] as const).flatMap((destination) => {
				const selected = updates.filter((update) => update.destination === destination);
				if (!selected.length) return [];
				const plan = stageSettingsWrite(destinations[destination], destination, selected);
				const parsed = parseSourcePolicy(plan.settings, plan.source);
				if (parsed.errors.length) throw new Error(parsed.errors.join("\n"));
				return [plan];
			});
			const advanceTrust = preparePermissionTrustUpdate(
				ctx,
				new Map(
					plans.map((plan) => [
						plan.source.path,
						{
							before: plan.before,
							after: `${JSON.stringify(plan.settings, null, 2)}\n`,
						},
					]),
				),
				home,
			);
			const expectedContents = acceptedContents.map((entry) => ({ ...entry }));
			const expectedRevision = revision;
			const expectedSession = ctx.sessionManager.getSessionId();
			const assertCurrent = () => {
				if (
					revision !== expectedRevision ||
					sessionId !== expectedSession ||
					ctx.sessionManager.getSessionId() !== expectedSession
				)
					throw new Error("Permission policy changed before update commit");
			};
			return async (signal: AbortSignal, commit: (change: () => void) => void) => {
				signal.throwIfAborted();
				assertCurrent();
				let written = 0;
				const saved: string[] = [];
				try {
					for (const plan of plans) {
						signal.throwIfAborted();
						assertCurrent();
						const result = await persistSettingsWrite(plan, signal);
						if (result.written) {
							written++;
							saved.push(plan.source.path);
						}
						if (result.message) say(ctx, result.message, "warning");
					}
					signal.throwIfAborted();
					assertCurrent();
					if (saved.length) advanceTrust(saved);
					const snapshot = plans.length ? await capture(ctx) : undefined;
					signal.throwIfAborted();
					assertCurrent();
					if (snapshot) {
						if (snapshot.id !== expectedSession)
							throw new Error("Permission session changed before update publication");
						const expected = expectedContents.map((entry) => {
							const own = plans.find(
								(plan) => plan.source.path === entry.source.path && saved.includes(plan.source.path),
							);
							return own
								? {
										source: entry.source,
										text: `${JSON.stringify(own.settings, null, 2)}\n`,
										error: undefined,
									}
								: entry;
						});
						if (JSON.stringify(snapshot.contents) !== JSON.stringify(expected))
							throw new Error("External permission settings changed during update commit");
					}
					commit(() => {
						if (snapshot) install(snapshot);
						sessionRules = nextSession;
						if (plans.length) {
							transient = { rules: [], errors: [] };
							if (!written) {
								// Failed saves retain the attempted source rules for this process. A successful
								// settings reload instead restores the normal per-source trust boundary.
								for (const plan of plans) transient.rules.push(...parseSourcePolicy(plan.settings, plan.source).rules);
								// The failed destination itself must not turn this approved update into a malformed-policy denial.
								const failedPaths = new Set(plans.map((plan) => plan.source.path));
								basePolicy = {
									rules: basePolicy.rules.filter((rule) => !failedPaths.has(rule.source.path)),
									errors: basePolicy.errors,
								};
							}
						}
						publish(ctx);
					});
				} catch (error) {
					if (saved.length)
						throw new Error(
							`Permission updates saved to ${saved.join(", ")} before the operation stopped: ${errorMessage(error)}`,
							{ cause: error },
						);
					throw error;
				}
			};
		},
		refresh,
		unprojected: (toolName: string) => unprojectedSourcePolicy(policy, toolName),
		evaluate: (invocation: ToolInvocation, cwd: string) => evaluateSourcePolicy(policy, invocation, cwd),
		get enabled() {
			return enabled;
		},
	};
}
