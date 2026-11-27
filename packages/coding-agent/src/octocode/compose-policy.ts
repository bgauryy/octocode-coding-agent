import type { FeatureContext, FeatureSetup } from "../core/features/index.ts";
import { projectEditHunk } from "./native/tools/file/tool.ts";
import type { FileGuard } from "./files/tool/guard.ts";
import { registerHooksPromptSection } from "./hooks/prompt-section.ts";
import { registerHooks } from "./hooks/register.ts";
import type { HooksView } from "./hooks/register/types.ts";
import { messagePolicy } from "./message-policy.ts";
import type { Permission } from "./permission/ask.ts";
import type { createProvenance } from "./permission/provenance.ts";
import { registerSourcePolicy } from "./permission/source-policy-loader.ts";
import type { registerPlanning } from "./plan/register.ts";
import type { Team } from "./team/session.ts";
import { AGENT_ID_ENV, AGENT_ROLE_ENV } from "./team/store/env.ts";

/** The features composed after earlier callbacks already use them (see `composedLater` in `index.ts`). */
export interface ComposedLater {
	hooks: HooksView;
	sourcePolicy: ReturnType<typeof registerSourcePolicy>;
	messaging: ReturnType<typeof messagePolicy>;
}

/** The registry of `ComposedLater`: `set` publishes a feature, `get` throws until it is set. */
export interface LaterRegistry {
	set<K extends keyof ComposedLater>(name: K, value: ComposedLater[K]): ComposedLater[K];
	get<K extends keyof ComposedLater>(name: K): ComposedLater[K];
}

/**
 * Registers the hooks, the source policy and the message policy, in that order, and wires them into the permission state
 * and the team. Each is published through `later` as soon as it exists.
 */
export function composePolicy(
	api: FeatureSetup,
	options: {
		later: LaterRegistry;
		permission: Permission;
		planning: ReturnType<typeof registerPlanning>;
		provenance: ReturnType<typeof createProvenance>;
		team: Team;
		guard: FileGuard;
	},
): ComposedLater {
	const { later, permission, planning, provenance, team, guard } = options;
	const hooks = later.set(
		"hooks",
		registerHooks(api, {
			env: process.env,
			onFailure: (what, note, allowed) => permission.noted(what, note, { allowed, via: "hook" }),
			metadata: () => ({
				permissionMode: permission.mode,
				agentName: process.env[AGENT_ID_ENV],
				agentType: process.env[AGENT_ROLE_ENV],
			}),
			paused: planning.blocked,
			projectEdit: (query, path, cwd) => projectEditHunk(query, path, guard, cwd),
		}),
	);
	registerHooksPromptSection(api, hooks);
	const applySourcePolicy = () => {
		const policy = later.get("sourcePolicy");
		permission.setSourcePolicy(policy.evaluate, policy.unprojected);
	};
	const sourcePolicy = later.set("sourcePolicy", registerSourcePolicy(api, { onChange: applySourcePolicy }));
	applySourcePolicy();
	permission.setResolver((ctx, invocation, signal) =>
		hooks.permissionRequest(invocation, ctx as FeatureContext, signal),
	);
	permission.setUpdateHandler(async (ctx, updates, signal) => {
		await sourcePolicy.refresh(ctx as FeatureContext);
		signal.throwIfAborted();
		return sourcePolicy.prepareUpdates(ctx as FeatureContext, updates);
	});
	const messaging = later.set("messaging", messagePolicy({ api, hooks, permission, planning, provenance, team }));
	team.setMessageHook(messaging.beforeMessage);
	return { hooks, sourcePolicy, messaging };
}
