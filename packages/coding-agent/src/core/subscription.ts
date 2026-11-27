import type { ProviderPlan } from "@octocodeai/octocode-ai";

/** What decides whether a provider's usage is paid by a subscription: its plan fact and its current login. */
interface BillingFacts {
	plan?: ProviderPlan;
	/** The provider is signed in with an OAuth login. */
	usingOAuth: boolean;
	/** That login is one the provider marks as a subscription (`OAuthAuth.isSubscription`). */
	oauthIsSubscription: boolean;
}

/**
 * Whether usage is paid by a subscription, so a cost figure is an estimate of API value, not a bill. A provider whose
 * plan bills by plan counts for every credential; otherwise a subscription OAuth login does.
 */
export function isSubscriptionBilled(facts: BillingFacts): boolean {
	if (facts.plan?.billing === "plan") return true;
	return facts.usingOAuth && facts.oauthIsSubscription;
}

/**
 * Whether the vendor allows unattended use of this provider's plan. When it does not, automatic model choice for print
 * mode, an ACP server's session and background children skips the provider; a model the user names still runs, with a
 * notice.
 */
export function allowsUnattended(plan: ProviderPlan | undefined): boolean {
	return plan?.unattended !== false;
}
