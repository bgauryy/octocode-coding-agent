import { bedrockProviderModule } from "@octocodeai/octocode-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@octocodeai/octocode-ai/bun-oauth";
import { setBedrockProviderModule } from "@octocodeai/octocode-ai/compat";
// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = () => {};
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
