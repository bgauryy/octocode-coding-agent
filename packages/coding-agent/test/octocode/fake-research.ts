/** The policy's research context (`policy.ts` `PromptInputs.research`) for the fake research server of `fake-research-roles.ts`. */
import { resolveToolRoles } from "../../../mcp/src/roles.ts";
import { RESEARCH_ENTRY } from "./fake-research-roles.ts";

export const FAKE_RESEARCH = resolveToolRoles([RESEARCH_ENTRY]).research!;
