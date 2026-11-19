#!/usr/bin/env node
// Fails when a generated reference page differs from what `generate:references` would write. Renders in memory and
// rewrites nothing.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReferences } from "../generate-references.ts";

const packageDirectory = fileURLToPath(new URL("../..", import.meta.url));

const stale = [...renderReferences()]
	.filter(([relativePath, content]) => {
		const path = resolve(packageDirectory, relativePath);
		return !existsSync(path) || readFileSync(path, "utf-8") !== content;
	})
	.map(([relativePath]) => `packages/coding-agent/${relativePath}`);

if (stale.length > 0) {
	console.error(`Stale reference pages:\n${stale.map((page) => `  ${page}`).join("\n")}`);
	console.error("Run: yarn workspace @octocodeai/octocode-agent run generate:references");
	process.exitCode = 1;
} else console.log("Reference pages match their generators.");
