import type { IncomingMessage } from "node:http";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	ApplicationAssetInputSchema,
	APPLICATION_UPLOAD_BYTES,
	WORKSPACE_ROUTES,
	type ApplicationAssetPayload,
	type ApplicationPort,
} from "@octocodeai/octocode-contacts";
import { redactData, redactSecrets } from "../shared/sanitize.ts";

const UploadSchema = Type.Object(
	{
		...ApplicationAssetInputSchema.properties,
		sessionId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
type Reply = (status: number, body: unknown) => void;

/** JSON assets receive the same redaction as frames; binary payloads must not be rewritten. */
function publicAsset(value: ApplicationAssetPayload): ApplicationAssetPayload {
	if (value.encoding !== "utf8") return { ...value, asset: redactData(value.asset) };
	let data = redactSecrets(value.data);
	if (value.asset.mimeType === "application/json") {
		try {
			data = JSON.stringify(redactData(JSON.parse(value.data)));
		} catch {
			/* Plain text still receives redaction. */
		}
	}
	return { ...value, asset: { ...redactData(value.asset), size: Buffer.byteLength(data) }, data };
}

/** Called only after the loopback host, origin and bearer capability have been checked. */
export async function handleApplicationDataRequest(
	req: IncomingMessage,
	url: URL,
	port: ApplicationPort | undefined,
	sessionId: string,
	reply: Reply,
): Promise<boolean> {
	const isHistory = url.pathname === WORKSPACE_ROUTES.history;
	const isAssets = url.pathname === WORKSPACE_ROUTES.assets;
	const isAsset = url.pathname.startsWith(WORKSPACE_ROUTES.assets + "/");
	if (!isHistory && !isAssets && !isAsset) return false;
	if (!port) {
		reply(503, { error: "Application data is unavailable in this session" });
		return true;
	}
	if (req.method === "GET") {
		if (url.searchParams.get("sessionId") !== sessionId) {
			reply(409, { error: "Session changed" });
			return true;
		}
		if (isHistory && port.history) {
			const limit = url.searchParams.get("limit");
			if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) {
				reply(400, { error: "History limit must be between 1 and 100" });
				return true;
			}
			reply(
				200,
				redactData(
					await port.history({
						sessionId,
						before: url.searchParams.get("before") ?? undefined,
						activityBefore: url.searchParams.get("activityBefore") ?? undefined,
						limit: limit === null ? undefined : Number(limit),
					}),
				),
			);
			return true;
		}
		if (isAsset && port.readAsset) {
			const id = url.pathname.slice(WORKSPACE_ROUTES.assets.length + 1);
			const payload = /^[a-f0-9]{64}$/.test(id) ? await port.readAsset(id, sessionId) : undefined;
			reply(payload ? 200 : 404, payload ? publicAsset(payload) : { error: "Asset not found in this session" });
			return true;
		}
		reply(404, { error: "Application data is unavailable" });
		return true;
	}
	if (!isAssets || req.method !== "POST") {
		reply(405, { error: "Unsupported application data operation" });
		return true;
	}
	if (!port.uploadAsset) {
		reply(503, { error: "Attachments are unavailable" });
		return true;
	}
	if (req.headers["content-type"] !== "application/json") {
		reply(400, { error: "Use JSON" });
		return true;
	}
	const maxBytes = Math.ceil(APPLICATION_UPLOAD_BYTES / 3) * 4 + 4096;
	if (Number(req.headers["content-length"]) > maxBytes) {
		reply(413, { error: "Image exceeds 20 MiB" });
		return true;
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of req) {
		bytes += chunk.length;
		if (bytes > maxBytes) {
			reply(413, { error: "Image exceeds 20 MiB" });
			return true;
		}
		chunks.push(chunk);
	}
	let input: unknown;
	try {
		input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		reply(400, { error: "Invalid JSON" });
		return true;
	}
	if (!Value.Check(UploadSchema, input)) {
		reply(400, { error: "Invalid image attachment" });
		return true;
	}
	if (input.sessionId !== sessionId) {
		reply(409, { error: "Session changed" });
		return true;
	}
	try {
		reply(201, { asset: await port.uploadAsset(input, sessionId) });
	} catch (error) {
		reply(400, { error: error instanceof Error ? redactSecrets(error.message) : "Upload failed" });
	}
	return true;
}
