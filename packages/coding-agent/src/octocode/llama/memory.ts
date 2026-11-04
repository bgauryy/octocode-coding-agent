import os from "node:os";
import { formatBytes } from "../../utils/bytes.ts";

/**
 * What a local model of this size means for this machine, when it may not fit: a model is held in memory while it runs,
 * so a file larger than the free memory pushes the machine into swap or freezes it. A warning, never a refusal: free
 * memory is an estimate, and the owner of the machine decides.
 */
export function memoryWarning(
	size: number | undefined,
	free: number = os.freemem(),
	total: number = os.totalmem(),
): string | undefined {
	if (size === undefined || size < free) return undefined;
	const model = formatBytes(size, "binary");
	return size >= total
		? `This model is ${model}, more than this machine's ${formatBytes(total, "binary")} of memory: running it may freeze the machine.`
		: `This model is ${model} and ${formatBytes(free, "binary")} of memory is free: running it may freeze the machine unless you close other programs.`;
}
