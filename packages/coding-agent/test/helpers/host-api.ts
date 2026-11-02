/**
 * The host surface the example fixtures under `test/fixtures/extensions/` import. The product exposes no extension
 * API; the fixtures stay as consumers of the internal feature API, so this barrel names what they use in one place
 * (and gives a test one module to `vi.mock`).
 */
export { CONFIG_DIR_NAME, getAgentDir } from "../../src/config.ts";
export type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../../src/core/features/index.ts";
export { createBashToolDefinition } from "../../src/core/tools/bash.ts";
export { withFileMutationQueue } from "../../src/core/tools/file-mutation-queue.ts";
export type { ModelRoute, ModelRouteRequest } from "../../src/core/virtual-models.ts";
export type { Theme } from "../../src/theme/theme-class.ts";
export { getMarkdownTheme } from "../../src/theme/theme-tui-helpers.ts";
export { parseFrontmatter } from "../../src/utils/frontmatter.ts";
