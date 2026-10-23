import path from "node:path";
import { sha256 } from "../octocode/shared/atomic.ts";
import { globalPaths } from "../octocode/shared/home.ts";
import type { PluginManifest } from "./plugin-manifest.ts";

export interface PluginContext {
 id: string;
 root: string;
 data: string;
}

/** One local plugin identity across instruction resources and executable hooks. */
export function pluginContext(manifest: Pick<PluginManifest, "protocol" | "name" | "root">, home?: string): PluginContext {
 const id = `${manifest.protocol}:${manifest.name}:${manifest.root}`;
 return { id, root: manifest.root, data: path.join(path.dirname(globalPaths(process.env, home).hooks), "plugins", "data", sha256(id)) };
}
