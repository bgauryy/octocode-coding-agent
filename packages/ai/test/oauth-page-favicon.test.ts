import { expect, it } from "vitest";
import { OCTOCODE_FAVICON_DATA_URI } from "../src/utils/favicon.generated.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "../src/utils/oauth-page.ts";

it.each([oauthSuccessHtml("Signed in."), oauthErrorHtml("Failed.", "details")])(
	"links the Octocode favicon in OAuth pages",
	(html) => {
		expect(html).toContain(`<link rel="icon" type="image/png" href="${OCTOCODE_FAVICON_DATA_URI}" />`);
	},
);

it.each([oauthSuccessHtml("Signed in."), oauthErrorHtml("Failed.", "details")])(
	"shows Octocode's mark on the page, never Pi's",
	(html) => {
		expect(html).toContain(`<img src="${OCTOCODE_FAVICON_DATA_URI}"`);
		// Pi's mark is three coloured paths; none of its colours may appear.
		expect(html).not.toMatch(/#F09082|#4D9ABF|#F1BE58/);
	},
);
