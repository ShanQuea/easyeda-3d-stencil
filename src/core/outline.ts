import type { Path, Paths } from './geom';
// 板框层是一圈有宽度的线，真正的板边是线的中心。先试着串成闭环，不行再退到描边内孔、包围盒
import type { GerberImage } from './gerber';
import { bounds, islands, offset, pathArea, SCALE, toMm, union } from './geom';
import { flattenImage } from './gerber';

export type OutlineMethod = 'chained' | 'region' | 'stroke' | 'bbox' | 'none';

export interface BoardOutline {
	board: Paths;
	cutouts: Paths;
	method: OutlineMethod;
}

const SNAP_LEVELS = [2, 10, 50, 200];
const MIN_LOOP_AREA = 0.5;

export function extractOutline(image: GerberImage, fallback: Paths = []): BoardOutline {
	const segments = image.tracks.filter(t => t.dark && t.points.length >= 2).map(t => t.points);

	// 自闭合的小圆在最小容差下就成环了，外框却可能差一点点没接上，所以要等所有线段都串上才停
	let best: Paths = [];
	let bestArea = 0;
	for (const snap of SNAP_LEVELS) {
		const { loops, open } = chain(segments, snap);
		if (loops.length && !open) {
			return finish(loops, 'chained');
		}
		const area = loops.reduce((sum, loop) => sum + Math.abs(pathArea(loop)), 0);
		if (area > bestArea) {
			best = loops;
			bestArea = area;
		}
	}
	if (best.length) {
		return finish(best, 'chained');
	}

	const flat = flattenImage(image);
	if (image.regionCount > 0 && !segments.length && flat.length) {
		return finish(flat, 'region');
	}

	// 线没有严格闭合时，描粗后的线通常还是能围出一个封闭的内孔
	const width = Math.max(0, ...image.tracks.map(t => t.width));
	const holes: Paths = [];
	for (const island of islands(flat)) {
		holes.push(...island.holes);
	}
	if (holes.length) {
		const grown = offset(holes.map(h => h.slice().reverse()), toMm(width) / 2, 'miter');
		if (grown.length) {
			return finish(grown, 'stroke');
		}
	}

	const box = bounds(flat.length ? flat : fallback);
	if (box) {
		// 板框层的包围盒包含了线宽，paste 层兜底时再留 2mm 边
		const pad = flat.length ? -width / 2 : 2 * SCALE;
		const board: Path = [
			{ X: box.minX - pad, Y: box.minY - pad },
			{ X: box.maxX + pad, Y: box.minY - pad },
			{ X: box.maxX + pad, Y: box.maxY + pad },
			{ X: box.minX - pad, Y: box.maxY + pad },
		];
		return { board: [board], cutouts: [], method: 'bbox' };
	}
	return { board: [], cutouts: [], method: 'none' };
}

function finish(loops: Paths, method: OutlineMethod): BoardOutline {
	const board: Paths = [];
	const cutouts: Paths = [];
	// 奇偶规则：环套环时，里面那圈是开槽
	for (const island of islands(loops, true)) {
		if (Math.abs(pathArea(island.outer)) < MIN_LOOP_AREA) {
			continue;
		}
		board.push(island.outer);
		cutouts.push(...island.holes);
	}
	return { board: union(board), cutouts, method: board.length ? method : 'none' };
}

// 有分叉或断头的链直接放弃，只要干净闭合的环
export function chainLoops(polylines: Paths, snap: number): Paths {
	return chain(polylines, snap).loops;
}

// open 是没能串进闭环的线段数
function chain(polylines: Paths, snap: number): { loops: Paths; open: number } {
	const cell = Math.max(1, snap);
	const grid = new Map<string, number[]>();
	const nodePoints: Array<{ X: number; Y: number }> = [];

	const nodeOf = (p: { X: number; Y: number }): number => {
		const gx = Math.floor(p.X / cell);
		const gy = Math.floor(p.Y / cell);
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (const id of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
					if (Math.hypot(nodePoints[id].X - p.X, nodePoints[id].Y - p.Y) <= snap) {
						return id;
					}
				}
			}
		}
		const id = nodePoints.length;
		nodePoints.push(p);
		const key = `${gx},${gy}`;
		const bucket = grid.get(key);
		if (bucket) {
			bucket.push(id);
		}
		else {
			grid.set(key, [id]);
		}
		return id;
	};

	interface Edge { a: number; b: number; points: Path; used: boolean }
	const edges: Edge[] = [];
	const loops: Paths = [];
	for (const points of polylines) {
		const a = nodeOf(points[0]);
		const b = nodeOf(points[points.length - 1]);
		if (a === b) {
			// 自己就闭合的折线（比如一整个圆）
			if (points.length >= 4) {
				loops.push(points.slice(0, -1));
			}
			continue;
		}
		edges.push({ a, b, points, used: false });
	}

	const incident = new Map<number, Edge[]>();
	for (const edge of edges) {
		for (const node of [edge.a, edge.b]) {
			const list = incident.get(node);
			if (list) {
				list.push(edge);
			}
			else {
				incident.set(node, [edge]);
			}
		}
	}

	let open = 0;
	for (const start of edges) {
		if (start.used) {
			continue;
		}
		const loop: Path = [];
		let count = 0;
		let edge: Edge | undefined = start;
		let node = start.a;
		let closed = false;
		while (edge && !edge.used) {
			edge.used = true;
			count++;
			const forward = edge.a === node;
			const points = forward ? edge.points : edge.points.slice().reverse();
			// 每段的终点留给下一段的起点
			loop.push(...points.slice(0, -1));
			node = forward ? edge.b : edge.a;
			if (node === start.a) {
				closed = true;
				break;
			}
			const candidates: Edge[] = incident.get(node) ?? [];
			if (candidates.length !== 2) {
				break;
			}
			edge = candidates.find(e => !e.used);
		}
		if (closed && loop.length >= 3) {
			loops.push(loop);
		}
		else {
			open += count;
		}
	}
	return { loops, open };
}
