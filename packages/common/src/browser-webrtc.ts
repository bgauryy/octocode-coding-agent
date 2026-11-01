import fs from "node:fs";
import path from "node:path";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { atomicWriteFileSync } from "./atomic-file.ts";
import { PRIVATE_FILE_MODE } from "./file-mode.ts";

/**
 * WebRTC's UDP (ICE: STUN and TURN servers a page names, host candidates) does not go through the HTTP proxy or the CDP
 * request guard, so a page could send packets to a private address. Chrome reads this policy from the profile
 * preference `webrtc.ip_handling_policy`; the `--force-webrtc-ip-handling-policy` switch is honored only by content_shell
 * and old headless, not by Chrome (verified: Chrome 155 still sent STUN and TURN datagrams to a loopback server with it).
 * `disable_non_proxied_udp` allows UDP only through a proxy that supports it, so none is sent and no address is gathered.
 */
const WEBRTC_POLICY = "disable_non_proxied_udp";

/**
 * Sets `webrtc.ip_handling_policy` in the profile's `Default/Preferences`, keeping every other preference, before Chrome
 * starts on `userDataDir` (a running Chrome would overwrite the file). Throws when it cannot: Chrome must not start
 * without the policy.
 */
export function restrictWebRtc(userDataDir: string): void {
	const file = path.join(userDataDir, "Default", "Preferences");
	let prefs: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isRecord(parsed)) prefs = parsed;
	} catch (error) {
		// No file yet (a fresh profile), or one Chrome could not read either and would rebuild.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
	}
	const webrtc = asRecord(prefs.webrtc);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	atomicWriteFileSync(file, JSON.stringify({ ...prefs, webrtc: { ...webrtc, ip_handling_policy: WEBRTC_POLICY } }), {
		mode: PRIVATE_FILE_MODE,
	});
}
