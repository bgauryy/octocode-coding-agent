import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { githubTokenPresent, resetGithubToken } from "../../src/octocode/ui/footer/github.ts";
import { tmp } from "./helpers.ts";

const NOW = 1_000_000;
const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
/** An environment without any token or gh config of the machine running the test. */
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...extra });

describe("githubTokenPresent", () => {
	beforeEach(() => resetGithubToken());

	it("is true for a token in the environment", () => {
		expect(githubTokenPresent(NOW, env({ GH_TOKEN: "ghp_x" }), tmp())).toBe(true);
		resetGithubToken();
		expect(githubTokenPresent(NOW, env({ GITHUB_TOKEN: "ghp_y" }), tmp())).toBe(true);
	});

	it("is true for a gh login: a user in hosts.yml under GH_CONFIG_DIR", () => {
		const config = tmp();
		write(path.join(config, "hosts.yml"), "github.com:\n    user: octocat\n    oauth_token: abc\n");
		expect(githubTokenPresent(NOW, env({ GH_CONFIG_DIR: config }), tmp())).toBe(true);
	});

	it("ignores a hosts.yml without a user or token", () => {
		const config = tmp();
		write(path.join(config, "hosts.yml"), "github.com:\n    git_protocol: https\n");
		expect(githubTokenPresent(NOW, env({ GH_CONFIG_DIR: config }), tmp())).toBe(false);
	});

	it("is true for Octocode's own stored credentials in the home directory", () => {
		const home = tmp();
		write(path.join(home, ".octocode", "credentials.json"), '{"github":{"token":"t"}}');
		expect(githubTokenPresent(NOW, env({ GH_CONFIG_DIR: tmp() }), home)).toBe(true);
	});

	it("is false for an empty credentials file", () => {
		const home = tmp();
		write(path.join(home, ".octocode", "credentials.json"), "");
		expect(githubTokenPresent(NOW, env({ GH_CONFIG_DIR: tmp() }), home)).toBe(false);
	});

	it("is false with no token, no gh login and no stored credentials", () => {
		expect(githubTokenPresent(NOW, env({ GH_CONFIG_DIR: tmp() }), tmp())).toBe(false);
	});

	it("keeps its answer for a minute, then reads again; reset forgets it at once", () => {
		const home = tmp();
		const options = env({ GH_CONFIG_DIR: tmp() });
		expect(githubTokenPresent(NOW, options, home)).toBe(false);
		write(path.join(home, ".octocode", "credentials.json"), '{"github":{"token":"t"}}');
		// Inside the TTL the cached answer stands, however the disk changed.
		expect(githubTokenPresent(NOW + 59_999, options, home)).toBe(false);
		expect(githubTokenPresent(NOW + 60_000, options, home)).toBe(true);
		fs.rmSync(path.join(home, ".octocode", "credentials.json"));
		expect(githubTokenPresent(NOW + 60_001, options, home)).toBe(true);
		resetGithubToken();
		expect(githubTokenPresent(NOW + 60_002, options, home)).toBe(false);
	});
});
