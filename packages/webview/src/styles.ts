import { BASE_CSS } from "./styles/base.ts";
import { CHROME_CSS } from "./styles/chrome.ts";
import { VIEWS_CSS } from "./styles/views.ts";
import { LIVE_CSS } from "./styles/live.ts";
import { FEEDBACK_CSS } from "./styles/feedback.ts";

/**
 * Octocode design tokens, shared with the terminal themes (`coding-agent/src/theme/octocode-*.json`):
 * purple accent, GitHub-like neutrals, and status colors. Colors identify state; tags and metadata stay neutral.
 */
export const PAGE_CSS = [BASE_CSS, CHROME_CSS, VIEWS_CSS, LIVE_CSS, FEEDBACK_CSS].join("");
