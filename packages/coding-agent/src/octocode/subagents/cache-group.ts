import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { PROMPT_CACHE_KEY_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { AGENT_ID_ENV } from "../team/store/env.ts";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { CACHE_GROUP_ENTRY } from "../shared/cache-group-entry.ts";

// The provider's own reason for a miss is recorded on the assistant message (`cache_miss` diagnostic; children ask for
// it, see `process/env.ts`); this entry adds which group the child's prefix belongs to.

interface CacheGroupRecord {
	version: 1;
	/** The shared `OCTOCODE_PROMPT_CACHE_KEY` the parent gave the child's prefix group; absent when none was given. */
	key?: string;
	/** Hash of the system prompt and the active tool declarations, the bytes the provider caches first. */
	prefix: string;
}

/** A short hash of the system prompt and the declarations of the tools that are active. */
export function prefixHash(systemPrompt: string, tools: readonly unknown[]): string {
	return sha256(`${systemPrompt}\0${JSON.stringify(tools)}`).slice(0, 16);
}

function latest(branch: readonly SessionEntry[]): CacheGroupRecord | undefined {
	for (let at = branch.length - 1; at >= 0; at--) {
		const entry = branch[at];
		if (entry.type !== "custom" || entry.customType !== CACHE_GROUP_ENTRY) continue;
		const data = entry.data;
		if (isRecord(data) && data.version === 1 && typeof data.prefix === "string")
			return { version: 1, prefix: data.prefix, ...(typeof data.key === "string" ? { key: data.key } : {}) };
	}
	return undefined;
}

/** Records the child's cache group before each run's first request, once per distinct key and prefix. */
export function registerCacheGroup(api: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	if (!env[AGENT_ID_ENV]) return;
	const key = env[PROMPT_CACHE_KEY_ENV] || undefined;
	api.on("before_agent_start", async (event, ctx: Pick<ExtensionContext, "sessionManager">) => {
		const active = new Set(api.getActiveTools());
		const tools = api
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.map(({ name, description, parameters }) => ({ name, description, parameters }));
		const prefix = prefixHash(event.systemPrompt, tools);
		const known = latest(ctx.sessionManager.getBranch());
		if (known?.prefix === prefix && known.key === key) return;
		api.appendEntry(CACHE_GROUP_ENTRY, { version: 1, prefix, ...(key ? { key } : {}) } satisfies CacheGroupRecord);
	});
}
