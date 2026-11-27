import { mcpAdapter } from "./adapters/mcp.ts";
import { providersAdapter } from "./adapters/providers.ts";
import { resourcesAdapter } from "./adapters/resources.ts";
import { settingsAdapter } from "./adapters/settings.ts";
import { sourcesAdapter } from "./adapters/sources.ts";
import { togglesAdapter } from "./adapters/toggles.ts";
import { toolAdapter } from "./adapters/tool.ts";
import { type ConfigCatalog, createConfigCatalog } from "./catalog.ts";
import type { ConfigAdapter, ConfigContext } from "./types.ts";

export type { ConfigCatalog } from "./catalog.ts";
export * from "./types.ts";

const CONFIG_ADAPTERS: readonly ConfigAdapter[] = [
	settingsAdapter,
	toolAdapter,
	mcpAdapter,
	togglesAdapter,
	resourcesAdapter,
	providersAdapter,
	sourcesAdapter,
];

/** The catalog over all adapters, bound to `ctx`. */
export const createConfiguration = (ctx: ConfigContext): ConfigCatalog => createConfigCatalog(ctx, CONFIG_ADAPTERS);
