/**
 * The scan preview the Harness panel shows before a harness source is switched on: the same static scan and text
 * `/harness` prints (`previewSource`, `renderPreview`). It reads folders and writes nothing.
 */

import type { HarnessPreview } from "@octocodeai/octocode-contracts/config";
import { configDiscovery } from "../../core/discovery/service.ts";
import { previewSource, renderPreview } from "../harness/scan-preview.ts";
import { open, type HarnessConfigOptions } from "./harness-config.ts";

/** At most this many item lines are sent; the rest are counted in the closing line. */
const LINE_LIMIT = 12;

/** Previews switching `id` (`harness:<vendor>`) on; no lines for a row without a source to scan. Throws when the scan fails. */
export async function previewHarness(id: string, options: HarnessConfigOptions): Promise<HarnessPreview> {
	const { trusted, settings } = open(options);
	const harness = id.startsWith("harness:") ? id.slice("harness:".length) : "";
	const preview = await configDiscovery.pass(async () =>
		previewSource(harness, {
			cwd: options.cwd ?? options.agentDir,
			agentDir: options.agentDir,
			projectTrusted: trusted,
			settings: settings.getSettings(),
			...(options.home ? { home: options.home } : {}),
		}),
	);
	if (!preview) return { id, label: harness, items: 0, lines: [] };
	return {
		id,
		label: preview.label.slice(0, 512),
		items: preview.rows.length,
		lines: renderPreview(preview, LINE_LIMIT),
	};
}
