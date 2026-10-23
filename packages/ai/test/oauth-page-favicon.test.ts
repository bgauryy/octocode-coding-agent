import { expect, it } from "vitest";
import { OCTOCODE_FAVICON_DATA_URI } from "../src/utils/favicon.generated.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "../src/utils/oauth-page.ts";

it.each([oauthSuccessHtml("Signed in."), oauthErrorHtml("Failed.", "details")])(
	"links the Octocode favicon in OAuth pages",
	(html) => {
		expect(html).toContain(`<link rel="icon" type="image/png" href="${OCTOCODE_FAVICON_DATA_URI}" />`);
	},
);
