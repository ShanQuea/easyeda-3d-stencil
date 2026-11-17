// 细间距合并成条：喷嘴打不出一个个小孔时，把一排脚的开孔并成一条窄缝。
// 锡膏刷成一条，回流时被拉回到焊盘和引脚上（阻焊上不沾锡），跟拖焊一个道理。
// 关键是锡要少，所以条宽按这一排焊盘原本的开孔面积乘比例反推，而不是盖满焊盘
import type { Path, Paths } from './geom';
import { islands, pathArea, toMm, toUnits, union } from './geom';

export interface Strip {
	// 条的中心（mm，和开孔同一坐标系）
	x: number;
	y: number;
	pads: number;
	pitch: number;
}

interface Pad {
	path: Path;
	x: number;
	y: number;
	// 长轴方向（焊盘长度方向）的单位向量
	ax: number;
	ay: number;
	length: number;
	width: number;
	area: number;
}

const ANGLE_TOLERANCE = Math.sin((3 * Math.PI) / 180);
const MIN_PADS = 3;

/**
 * 找出脚距小于 minPitch 的整排焊盘（至少 3 个，同尺寸、同朝向、排成一线）。
 * apply 为 false 时只找不改，用来提示用户可以开这个选项
 */
export function mergeFineRows(apertures: Paths, minPitch: number, minOpening: number, ratio: number, apply: boolean): { apertures: Paths; strips: Strip[] } {
	const others: Paths = [];
	const pads: Pad[] = [];
	for (const island of islands(apertures)) {
		const pad = island.holes.length ? undefined : describe(island.outer);
		if (pad) {
			pads.push(pad);
		}
		else {
			others.push(island.outer, ...island.holes);
		}
	}

	const parent = pads.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	for (let i = 0; i < pads.length; i++) {
		for (let j = i + 1; j < pads.length; j++) {
			if (neighbours(pads[i], pads[j], minPitch)) {
				parent[find(i)] = find(j);
			}
		}
	}
	const groups = new Map<number, Pad[]>();
	pads.forEach((pad, i) => groups.set(find(i), [...groups.get(find(i)) ?? [], pad]));

	const strips: Strip[] = [];
	const merged: Paths = [];
	const kept: Paths = [];
	for (const row of groups.values()) {
		if (row.length < MIN_PADS) {
			kept.push(...row.map(p => p.path));
			continue;
		}
		const { path, strip } = toStrip(row, minOpening, ratio);
		strips.push(strip);
		if (apply) {
			merged.push(path);
		}
		else {
			kept.push(...row.map(p => p.path));
		}
	}
	if (!apply || !merged.length) {
		return { apertures, strips };
	}
	return { apertures: union([...others, ...kept, ...merged]), strips };
}

// 用顶点的二阶矩求主方向，矩形、长圆焊盘都够用
function describe(path: Path): Pad | undefined {
	const n = path.length;
	if (n < 3) {
		return undefined;
	}
	let cx = 0;
	let cy = 0;
	for (const p of path) {
		cx += p.X;
		cy += p.Y;
	}
	cx /= n;
	cy /= n;
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (const p of path) {
		const dx = p.X - cx;
		const dy = p.Y - cy;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	const ax = Math.cos(angle);
	const ay = Math.sin(angle);
	let minU = Infinity;
	let maxU = -Infinity;
	let minV = Infinity;
	let maxV = -Infinity;
	for (const p of path) {
		const dx = p.X - cx;
		const dy = p.Y - cy;
		const u = dx * ax + dy * ay;
		const v = -dx * ay + dy * ax;
		minU = Math.min(minU, u);
		maxU = Math.max(maxU, u);
		minV = Math.min(minV, v);
		maxV = Math.max(maxV, v);
	}
	const length = toMm(maxU - minU);
	const width = toMm(maxV - minV);
	// 方形、圆形焊盘没有长短边，排不成「一排脚」
	if (length < width * 1.3) {
		return undefined;
	}
	return {
		path,
		x: toMm(cx + ((minU + maxU) / 2) * ax - ((minV + maxV) / 2) * ay),
		y: toMm(cy + ((minU + maxU) / 2) * ay + ((minV + maxV) / 2) * ax),
		ax,
		ay,
		length,
		width,
		area: Math.abs(pathArea(path)),
	};
}

function similar(a: number, b: number): boolean {
	return Math.abs(a - b) <= Math.max(a, b) * 0.15;
}

function neighbours(a: Pad, b: Pad, minPitch: number): boolean {
	if (Math.abs(a.ax * b.ay - a.ay * b.ax) > ANGLE_TOLERANCE || !similar(a.length, b.length) || !similar(a.width, b.width)) {
		return false;
	}
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const along = Math.abs(dx * a.ax + dy * a.ay);
	const across = Math.abs(-dx * a.ay + dy * a.ax);
	// 并排（沿长轴基本不错开），中间有缝，脚距又比喷嘴能打的小
	return along < a.length * 0.15 && across > a.width * 0.9 && across < minPitch;
}

function toStrip(row: Pad[], minOpening: number, ratio: number): { path: Path; strip: Strip } {
	const { ax, ay } = row[0];
	const bx = -ay;
	const by = ax;
	const vs = row.map(p => p.x * bx + p.y * by).sort((a, b) => a - b);
	const u = row.reduce((sum, p) => sum + p.x * ax + p.y * ay, 0) / row.length;
	const v = (vs[0] + vs[vs.length - 1]) / 2;
	const width = row.reduce((sum, p) => sum + p.width, 0) / row.length;
	const length = vs[vs.length - 1] - vs[0] + width;
	const padArea = row.reduce((sum, p) => sum + p.area, 0);
	const maxLength = Math.min(...row.map(p => p.length));
	const stripWidth = Math.min(maxLength, Math.max(minOpening * 1.15, (padArea * ratio) / length));

	const x = u * ax + v * bx;
	const y = u * ay + v * by;
	const corner = (su: number, sv: number) => ({
		X: toUnits(x + (su * stripWidth * ax + sv * length * bx) / 2),
		Y: toUnits(y + (su * stripWidth * ay + sv * length * by) / 2),
	});
	return {
		path: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
		strip: { x, y, pads: row.length, pitch: (vs[vs.length - 1] - vs[0]) / (row.length - 1) },
	};
}
