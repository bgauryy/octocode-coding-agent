import * as bundledPiAgentCore from "@octocodeai/octocode-agent-core";
import * as bundledPiAiCompat from "@octocodeai/octocode-ai/compat";
import * as bundledPiAiOauth from "@octocodeai/octocode-ai/oauth";
import * as bundledPiAiProviders from "@octocodeai/octocode-ai/providers/all";
import * as bundledPiTui from "@octocodeai/octocode-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import type { HostModuleSpecifier } from "./host-modules.ts";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @octocodeai/octocodecode.
import * as bundledPiCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<HostModuleSpecifier, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@octocodeai/octocode-agent-core": bundledPiAgentCore,
	"@octocodeai/octocode-tui": bundledPiTui,
	// Extensions resolve the octocode-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@octocodeai/octocode-ai": bundledPiAiCompat,
	"@octocodeai/octocode-ai/compat": bundledPiAiCompat,
	"@octocodeai/octocode-ai/oauth": bundledPiAiOauth,
	"@octocodeai/octocode-ai/providers/all": bundledPiAiProviders,
	"@octocodeai/octocodecode": bundledPiCodingAgent,
};
