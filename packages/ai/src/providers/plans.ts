import type { ProviderPlan } from "../auth/types.ts";

/**
 * Subscription and coding-plan facts of the built-in providers that share a vendor. Each `terms` page is the vendor's
 * statement of which clients and uses its plan allows.
 */

/** Kimi Code membership: direct use, with an honest client identity. */
export const KIMI_CODE_PLAN: ProviderPlan = {
	billing: "plan",
	access: "direct",
	terms: "https://www.kimi.com/code/docs/",
};

/** OpenCode Go: "designed for OpenCode and other coding agents". */
export const OPENCODE_GO_PLAN: ProviderPlan = {
	billing: "plan",
	access: "direct",
	terms: "https://opencode.ai/docs/go",
};

/** Alibaba Cloud Model Studio plans: interactive coding tools only, never scripts or backends. */
export const QWEN_PLAN: ProviderPlan = {
	billing: "plan",
	access: "direct",
	terms: "https://www.alibabacloud.com/help/en/model-studio/coding-plan",
	unattended: false,
};

/** Xiaomi MiMo Token Plan: coding tools only. */
export const XIAOMI_PLAN: ProviderPlan = {
	billing: "plan",
	access: "direct",
	terms: "https://platform.xiaomimimo.com/docs/en-US/tokenplan/subscription",
	unattended: false,
};

/** GLM Coding Plan: only the coding tools Z.ai lists, and Octocode is not listed. */
export const ZAI_CODING_PLAN: ProviderPlan = {
	billing: "plan",
	access: "unclear",
	terms: "https://docs.z.ai/devpack/tool/others",
	unattended: false,
};

/** GitHub Copilot: officially supported only in GitHub's own clients and OpenCode. */
export const GITHUB_COPILOT_PLAN: ProviderPlan = {
	billing: "plan",
	access: "unclear",
	terms: "https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies",
};
