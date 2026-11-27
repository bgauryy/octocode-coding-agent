export function getOctocodeUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `octocode/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
