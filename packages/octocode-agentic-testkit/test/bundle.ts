import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Repo layout lives here, in test code: the adapter only takes a path (option or env).
const BUNDLE = resolve(dirname(fileURLToPath(import.meta.url)), "../../coding-agent/dist/bundle/cli.js");
process.env.TESTKIT_OCTOCODE_AGENT_BUNDLE ??= BUNDLE;
