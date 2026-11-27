import { useMemo } from "react";
import { takeAccess } from "../../access.ts";
import { ConfigView } from "../config/ConfigView.tsx";
import { createDaemonApi } from "../daemon/api.ts";
import { scopedRoute } from "../../scope.ts";
import type { ViewProps } from "../extension.ts";

/** The id the host resolves to this session's repository; it is the only workspace the page offers. */
const SESSION_REPO_ID = "session";

/**
 * Provider sources, credentials with sign-in, provider switches, default model, Harness switches and tool pins for this
 * session. On the web daemon's page for a session the routes carry that session (`/s/<id>/...`), so the Tools panel
 * shows what the running session declares; on the session's own server they are the plain routes.
 */
export function SettingsPanel({ access, repo, section }: { access: string; repo: string; section?: string }) {
	const api = useMemo(() => createDaemonApi(access, (route) => scopedRoute(route)), [access]);
	const harness = useMemo(() => ({ list: api.harness, set: api.setHarness, preview: api.previewHarness }), [api]);
	const security = useMemo(() => ({ list: api.security, act: api.decideSecurity }), [api]);
	const runners = useMemo(() => ({ list: api.runners, act: api.actRunners }), [api]);
	const tools = useMemo(() => ({ list: api.tools, pin: api.pinTool }), [api]);
	const repos = useMemo(() => [{ id: SESSION_REPO_ID, name: repo }], [repo]);
	return (
		<ConfigView
			load={api.config}
			save={api.saveSetting}
			saveCredential={api.saveCredential}
			saveProvider={api.saveProvider}
			testProviders={api.testProviders}
			signIn={api.signIn}
			addMcp={api.addMcp}
			mcpAddStatus={api.mcpAddStatus}
			harness={harness}
			security={security}
			runners={runners}
			tools={tools}
			repos={repos}
			section={section}
		/>
	);
}

export function SettingsView({ index, params }: ViewProps) {
	return <SettingsPanel access={takeAccess()} repo={index.repo} section={params.section} />;
}
