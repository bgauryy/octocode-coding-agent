import { listVendorMcpServers } from "../../../../mcp/src/api.ts";
import { getNativeSkillsDir, getOctocodeSkillsDir } from "../../config.ts";
import { configDiscovery, discoveryInput } from "../../core/discovery/service.ts";
import { type VendorId, vendorToggleId } from "../../core/discovery/vendors/types.ts";
import { vendorSwitchTarget } from "../../core/extensibility/switch.ts";
import { effectivePlugins } from "../../core/extensibility/toggles.ts";
import type { Settings } from "../../core/settings-schema.ts";
import { loadSkillsFromDir } from "../../core/skills.ts";
import { installOctocodeDiscovery } from "../discovery/index.ts";
import { mcpItem, skillItem } from "../guard/items.ts";
import { enforces } from "../guard/registry.ts";
import { visible } from "../guard/visible.ts";
import { scan } from "../guard/scan.ts";
import { scopeFor } from "../guard/store.ts";
import { RATINGS, type Rating, type ReviewItem, type ReviewKind } from "../guard/types.ts";
import { loadHooks } from "../hooks/config.ts";
import { hookReviewItems } from "../hooks/review.ts";
import { columnRows } from "../../theme/columns.ts";

/**
 * What turning an external source (a harness: Claude Code, Codex, Cursor, ...) on would bring, each item scanned now by
 * the guard's static scan. The items are the ones the loaders build at load (same review items, same rules), so the
 * rating here is the rating `/security` shows later. Nothing is started, installed or looked up, and nothing is saved.
 */

interface PreviewRow {
	kind: ReviewKind;
	label: string;
	rating: Rating;
	/** The most severe finding, or what the item can do when no rule matched. */
	top: string;
}

export interface SourcePreview {
	label: string;
	/** Worst rating first, then by kind and name. */
	rows: PreviewRow[];
	/** Kinds the review does not enforce: their items load without an approval. */
	unenforced: ReviewKind[];
}

export interface PreviewOptions {
	cwd: string;
	agentDir: string;
	home?: string;
	projectTrusted: boolean;
	settings: Settings;
}

const KIND_WORDS: Record<ReviewKind, string> = { skill: "skill", mcp: "MCP server", hook: "hook" };
const KIND_ORDER: Record<ReviewKind, number> = { mcp: 0, hook: 1, skill: 2 };
const SEVERITY = (rating: Rating): number => RATINGS.indexOf(rating);

/** Names of the skills Octocode ships: a skill that takes one is rated CRITICAL, as at load. */
function shippedSkillNames(input: Parameters<typeof configDiscovery.discover>[1]): Set<string> {
	const names = new Set(
		configDiscovery
			.discover("skill", input)
			.filter((item) => item.provenance.scope === "builtin")
			.map((item) => item.name),
	);
	for (const skill of loadSkillsFromDir({ dir: getNativeSkillsDir(), source: "path" }).skills) names.add(skill.name);
	return names;
}

/** The review items of every skill, hook and MCP server `vendor`'s files define, as the loaders would build them. */
function vendorItems(vendor: VendorId, options: PreviewOptions): ReviewItem[] {
	const { cwd, agentDir, home, projectTrusted, settings } = options;
	installOctocodeDiscovery();
	const input = discoveryInput({
		cwd,
		agentDir,
		projectTrusted,
		...(home ? { home } : {}),
		builtinSkillsDir: getOctocodeSkillsDir(),
	});
	const shipped = shippedSkillNames(input);
	const skills = configDiscovery
		.discover("skill", input)
		.filter(
			(item) =>
				item.provenance.vendor === vendor &&
				!item.provenance.shadowedBy &&
				item.provenance.notLoaded !== "untrusted" &&
				item.provenance.notLoaded !== "ignored-code",
		)
		.map((item) =>
			skillItem({
				name: item.name,
				filePath: item.provenance.path,
				scope: item.provenance.scope === "project" ? scopeFor(item.provenance.path, cwd) : "global",
				bundledNames: shipped,
				...(home ? { home } : {}),
			}),
		);
	// A Claude Code or Codex hook file's handlers carry that harness as their protocol.
	// The handlers as they would load with this harness on; its other switches (`hooks:<host>`, per hook) still apply.
	const { config } = loadHooks(cwd, projectTrusted, home, {
		plugins: effectivePlugins(settings, cwd),
		toggles: { ...settings.toggles, [vendorToggleId(vendor)]: true },
	});
	const hooks = [...hookReviewItems(config, cwd, home)]
		.filter(([handler]) => handler.protocol === vendor)
		.map(([, item]) => item);
	const servers = listVendorMcpServers(vendor, { agentDir, cwd, projectTrusted }).map((server) =>
		mcpItem({
			name: server.name,
			source: server.source,
			scope: server.scope === "project" ? scopeFor(server.source, cwd) : "global",
			config: server.config as unknown as Record<string, unknown>,
			...(home ? { home } : {}),
		}),
	);
	return [...servers, ...hooks, ...skills];
}

/** The scanned preview of switching `harness` on, or undefined when it is not a switchable harness. */
export function previewSource(harness: string, options: PreviewOptions): SourcePreview | undefined {
	const target = vendorSwitchTarget(harness);
	if (!target) return undefined;
	const rows = vendorItems(target.vendor, options).map((item): PreviewRow => {
		const { rating, findings } = scan(item);
		return {
			kind: item.kind,
			label: item.label,
			rating,
			top: findings[0]?.text ?? `no rule matched; it can: ${item.grants[0] ?? "run"}`,
		};
	});
	rows.sort(
		(a, b) =>
			SEVERITY(b.rating) - SEVERITY(a.rating) ||
			KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
			a.label.localeCompare(b.label),
	);
	const unenforced = (Object.keys(KIND_ORDER) as ReviewKind[]).filter((kind) => !enforces(options.settings, kind));
	return { label: target.label, rows, unenforced };
}

const count = (rows: readonly PreviewRow[], kind: ReviewKind): string =>
	`${rows.filter((row) => row.kind === kind).length} ${KIND_WORDS[kind]}${rows.filter((row) => row.kind === kind).length === 1 ? "" : "s"}`;

/**
 * The preview as text: what it brings, one row per item (worst first, at most `limit`), and where approval happens.
 * Never says an item is safe: a rating is a static scan, not a verdict.
 */
export function renderPreview(preview: SourcePreview, limit = 12): string[] {
	const { rows } = preview;
	const lines = [
		rows.length
			? `${preview.label} would bring ${count(rows, "skill")}, ${count(rows, "mcp")}, ${count(rows, "hook")}. Static scan, worst first (nothing was started; origin not looked up):`
			: `${preview.label} has no skills, MCP servers or hooks for this folder.`,
		...columnRows(
			rows
				.slice(0, limit)
				.map((row) => [row.rating, KIND_WORDS[row.kind], `${visible(row.label)} \u2014 ${visible(row.top)}`]),
			{ gap: 1, indent: "  ", min: [8, 10] },
		),
	];
	if (rows.length > limit)
		lines.push(`  \u2026 and ${rows.length - limit} more; /security lists every item after the switch`);
	if (rows.length) {
		lines.push("Items stay off until you approve them in /security (list, show, approve).");
		if (preview.unenforced.length)
			lines.push(
				`Not enforced: ${preview.unenforced.map((kind) => `${KIND_WORDS[kind]}s`).join(", ")} load without approval (security.enforce).`,
			);
	}
	return lines;
}
