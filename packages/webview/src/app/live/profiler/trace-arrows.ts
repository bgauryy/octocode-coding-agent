import type { ProfileMessage } from "@octocodeai/octocode-contracts";
import type { Lane } from "./trace-model.ts";
import { timeToX, type Viewport } from "./trace-view.ts";

/** Message arrows between agent lanes: layout and hit-testing. */

export interface Arrow {
	message: ProfileMessage;
	fromLane: number;
	toLane: number;
	/** Epoch ms sent and delivered (sent when the delivery time is unknown). */
	sentAt: number;
	deliveredAt: number;
	x1: number;
	x2: number;
}

/** One arrow per receiver that has a lane: sender lane at send time to receiver lane at delivery time. */
export function layoutArrows(messages: readonly ProfileMessage[], lanes: readonly Lane[], viewport: Viewport): Arrow[] {
	const laneOf = new Map(lanes.map((lane, index) => [lane.agentId, index]));
	const arrows: Arrow[] = [];
	for (const message of messages) {
		const fromLane = laneOf.get(message.from);
		if (fromLane === undefined) continue;
		const deliveredAt = message.at + (message.deliveredMs ?? 0);
		if (deliveredAt < viewport.from || message.at > viewport.to) continue;
		for (const to of message.to) {
			const toLane = laneOf.get(to);
			if (toLane === undefined) continue;
			arrows.push({
				message,
				fromLane,
				toLane,
				sentAt: message.at,
				deliveredAt,
				x1: timeToX(message.at, viewport),
				x2: timeToX(deliveredAt, viewport),
			});
		}
	}
	return arrows;
}

/** The arrow whose segment passes within `slop` px of the point; `laneY` gives a lane's centre line. */
export function hitArrow(
	arrows: readonly Arrow[],
	x: number,
	y: number,
	laneY: (lane: number) => number,
	slop = 5,
): Arrow | undefined {
	let best: Arrow | undefined;
	let bestDistance = slop;
	for (const arrow of arrows) {
		const distance = segmentDistance(x, y, arrow.x1, laneY(arrow.fromLane), arrow.x2, laneY(arrow.toLane));
		if (distance <= bestDistance) {
			best = arrow;
			bestDistance = distance;
		}
	}
	return best;
}

function segmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
