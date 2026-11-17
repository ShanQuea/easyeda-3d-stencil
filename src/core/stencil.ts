// 打印姿态：钢网片平贴热床，围框朝上长，不用支撑。
// 贴床的光面是刮锡膏那面，用的时候整个翻过来扣在板上，
// 所以顶层要左右镜像；底层不用，Gerber 底层本来就是从顶面透视看的
import type { Bounds, Paths } from './geom';
import type { Strip } from './strips';
import { bounds, circle, clean, difference, intersection, islands, mirrorX, offset, pathArea, rect, SCALE, toUnits, translate, union } from './geom';
import { mergeFineRows } from './strips';

export type FrameMode = 'full' | 'corners' | 'none';
export type Side = 'top' | 'bottom';
// 3D 打印整个钢网 / 激光切一张平片 / 给外面做的钢网打个架子
export type Method = 'print' | 'laser' | 'jig';
// 钢网片怎么在架子里定位：图形居中 / 按实测边距 / 留余量目视对好再贴胶带
export type SheetAlign = 'center' | 'measure' | 'free';

export interface StencilParams {
	method: Method;
	side: Side;
	thickness: number;
	boardThickness: number;
	// 围框比板子矮多少（mm），保证钢网片能压实在板面上
	frameDrop: number;
	clearance: number;
	frameWidth: number;
	frameMode: FrameMode;
	cornerLength: number;
	notches: boolean;
	notchWidth: number;
	// 围框内角加避让圆，防止 FDM 内角堆料顶住板角
	cornerRelief: boolean;
	compensation: number;
	// 孔间筋不够一条线宽时，两边的孔各让一点
	keepWebs: boolean;
	// 喷嘴打不出的细间距整排脚，并成一条窄缝
	mergeRows: boolean;
	// 合并后的锡量占原来开孔的比例
	stripPaste: number;
	nozzle: number;
	// 下面是钢网架用的：钢网片尺寸（0 = 按板子自动）和厚度
	sheetWidth: number;
	sheetHeight: number;
	sheetThickness: number;
	sheetAlign: SheetAlign;
	// 实测：从刷锡那面看，钢网左边缘到最左开孔、下边缘到最下开孔的距离
	sheetLeft: number;
	sheetBottom: number;
	// 另一面已经贴了件，凹槽底要挖空
	secondSide: boolean;
}

export const DEFAULT_PARAMS: StencilParams = {
	method: 'print',
	side: 'top',
	thickness: 0.2,
	boardThickness: 1.6,
	frameDrop: 0.2,
	clearance: 0.15,
	frameWidth: 4,
	frameMode: 'full',
	cornerLength: 12,
	notches: true,
	notchWidth: 14,
	cornerRelief: true,
	compensation: 0,
	keepWebs: true,
	mergeRows: false,
	stripPaste: 0.6,
	nozzle: 0.4,
	sheetWidth: 0,
	sheetHeight: 0,
	sheetThickness: 0.12,
	sheetAlign: 'center',
	sheetLeft: 0,
	sheetBottom: 0,
	secondSide: false,
};

export interface StencilRegion {
	paths: Paths;
	height: number;
}

export interface WebFix {
	// 缩了几个孔
	count: number;
	// 单边最多缩了多少（mm）
	maxShrink: number;
}

export interface StencilModel {
	regions: StencilRegion[];
	board: Paths;
	cavity: Paths;
	plate: Paths;
	frame: Paths;
	apertures: Paths;
	webFix: WebFix;
	// 可以合并成条的整排脚；mergeRows 打开时就是已经合并的
	strips: Strip[];
	frameHeight: number;
	mirrored: boolean;
	shift: { x: number; y: number };
	bounds: Bounds;
}

const MIN_APERTURE_AREA = 0.002;

export function buildStencil(board: Paths, paste: Paths, params: StencilParams): StencilModel {
	const mirrored = params.side === 'top';
	let boardPaths = union(board);
	let pastePaths = paste;
	if (mirrored) {
		boardPaths = mirrorX(boardPaths);
		pastePaths = mirrorX(pastePaths);
	}

	const hasFrame = params.frameMode !== 'none';
	const frameHeight = hasFrame ? Math.max(0, params.boardThickness - params.frameDrop) : 0;
	const cavityRaw = offset(boardPaths, Math.max(0, params.clearance), 'miter');
	const plateRaw = clean(offset(cavityRaw, Math.max(0.5, params.frameWidth), 'round'));

	const box = bounds(plateRaw) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	const shift = { x: -Math.round((box.minX + box.maxX) / 2), y: -Math.round((box.minY + box.maxY) / 2) };
	boardPaths = translate(boardPaths, shift.x, shift.y);
	const cavity = translate(cavityRaw, shift.x, shift.y);
	const plate = translate(plateRaw, shift.x, shift.y);
	const plateBounds = bounds(plate) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

	let apertures = union(translate(pastePaths, shift.x, shift.y));
	if (params.compensation !== 0) {
		apertures = offset(apertures, params.compensation, 'miter');
	}
	apertures = clean(intersection(apertures, boardPaths)).filter(p => Math.abs(pathArea(p)) >= MIN_APERTURE_AREA);

	const minPitch = nozzlePreset(params.nozzle).minPitch;
	const rows = mergeFineRows(apertures, minPitch, params.nozzle * 0.75, params.stripPaste, params.mergeRows);
	apertures = rows.apertures;

	let webFix: WebFix = { count: 0, maxShrink: 0 };
	if (params.keepWebs) {
		const widened = widenWebs(apertures, params.nozzle);
		apertures = widened.apertures;
		webFix = widened.fix;
	}

	let frame: Paths = [];
	if (hasFrame && frameHeight > 0) {
		frame = difference(plate, cavity);
		if (params.frameMode === 'corners') {
			frame = intersection(frame, cornerBlocks(plateBounds, params));
		}
		const cuts: Paths = [];
		if (params.notches && params.frameMode === 'full') {
			cuts.push(...notchCuts(plateBounds, params));
		}
		if (params.cornerRelief) {
			cuts.push(...reliefCuts(boardPaths, params));
		}
		if (cuts.length) {
			frame = difference(frame, union(cuts));
		}
		frame = clean(frame);
	}

	const body = difference(plate, apertures);
	const sheet = frame.length ? clean(difference(body, frame)) : clean(body);

	const regions: StencilRegion[] = [{ paths: sheet, height: params.thickness }];
	if (frame.length) {
		regions.push({ paths: frame, height: params.thickness + frameHeight });
	}

	return { regions, board: boardPaths, cavity, plate, frame, apertures, webFix, strips: rows.strips, frameHeight, mirrored, shift, bounds: plateBounds };
}

// 相邻两个孔之间的筋窄于 minWeb 时，把筋两侧的孔各削掉一半差值，让筋刚好够一条线宽。
// 比如筋 0.15、喷嘴 0.2，两边各缩 0.025。
// 直接按每一对孔的真实间距算，不去猜筋的形状：圆角焊盘一整排的缝会连成一片，那样估出来的宽度不靠谱
function widenWebs(apertures: Paths, minWeb: number): { apertures: Paths; fix: WebFix } {
	const reach = toUnits(minWeb);
	const parts = islands(apertures).map((island) => {
		const paths = [island.outer, ...island.holes];
		return { paths, box: bounds(paths)!, cuts: [] as Paths };
	});
	const pairs: Array<[number, number]> = [];
	let maxShrink = 0;
	for (let i = 0; i < parts.length; i++) {
		const a = parts[i];
		for (let j = i + 1; j < parts.length; j++) {
			const b = parts[j];
			if (b.box.minX - a.box.maxX >= reach || a.box.minX - b.box.maxX >= reach || b.box.minY - a.box.maxY >= reach || a.box.minY - b.box.maxY >= reach) {
				continue;
			}
			const gap = gapBetween(a.paths[0], b.paths[0]);
			const shrink = (minWeb - gap) / 2;
			if (gap <= 0 || shrink < 0.002) {
				continue;
			}
			// 离对面孔不到（线宽 + 间距）/ 2 的那一条削掉，平行边正好让出 shrink
			const keep = (minWeb + gap) / 2;
			a.cuts.push(...offset(b.paths, keep, 'round'));
			b.cuts.push(...offset(a.paths, keep, 'round'));
			pairs.push([i, j]);
			maxShrink = Math.max(maxShrink, shrink);
		}
	}
	// 孔本来就窄的话再削就直接堵死了，这种宁可不动，留给可打印性检查去报
	const minOpening = minWeb * 0.75;
	const trim = (paths: Paths, cuts: Paths): Paths => {
		if (!cuts.length) {
			return paths;
		}
		const trimmed = clean(difference(paths, union(cuts))).filter(p => Math.abs(pathArea(p)) >= MIN_APERTURE_AREA);
		return trimmed.length && offset(trimmed, -minOpening / 2, 'miter').length ? trimmed : paths;
	};
	const first = parts.map(part => trim(part.paths, part.cuts));
	// 平行边这样就够了；圆角焊盘两头还会留下离得近的小尖角，再按削完的形状补一刀
	const second: Paths[] = first.map(() => []);
	for (const [i, j] of pairs) {
		second[i].push(...offset(first[j], minWeb * 0.98, 'round'));
		second[j].push(...offset(first[i], minWeb * 0.98, 'round'));
	}
	const result: Paths = [];
	let count = 0;
	first.forEach((paths, i) => {
		const final = trim(paths, second[i]);
		if (final !== parts[i].paths) {
			count++;
		}
		result.push(...final);
	});
	return { apertures: count ? result : apertures, fix: { count, maxShrink: count ? maxShrink : 0 } };
}

// 两个多边形外轮廓之间的最近距离（mm）
function gapBetween(a: Paths[number], b: Paths[number]): number {
	let best = Infinity;
	const scan = (points: Paths[number], edges: Paths[number]) => {
		for (const p of points) {
			for (let i = 0; i < edges.length; i++) {
				best = Math.min(best, pointToSegment(p, edges[i], edges[(i + 1) % edges.length]));
			}
		}
	};
	scan(a, b);
	scan(b, a);
	return best / SCALE;
}

function pointToSegment(p: Paths[number][number], a: Paths[number][number], b: Paths[number][number]): number {
	const dx = b.X - a.X;
	const dy = b.Y - a.Y;
	const len = dx * dx + dy * dy;
	const t = len ? Math.max(0, Math.min(1, ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / len)) : 0;
	return Math.hypot(p.X - a.X - t * dx, p.Y - a.Y - t * dy);
}

function cornerBlocks(box: Bounds, params: StencilParams): Paths {
	const size = toUnits(params.cornerLength + params.frameWidth + params.clearance) * 2;
	return [
		rect(box.minX, box.minY, size, size),
		rect(box.maxX, box.minY, size, size),
		rect(box.maxX, box.maxY, size, size),
		rect(box.minX, box.maxY, size, size),
	];
}

// 取板缺口：在长边中点把围框切开，手指能按住板子把钢网揭起来
function notchCuts(box: Bounds, params: StencilParams): Paths {
	const w = box.maxX - box.minX;
	const h = box.maxY - box.minY;
	const cx = (box.minX + box.maxX) / 2;
	const cy = (box.minY + box.maxY) / 2;
	const depth = toUnits(params.frameWidth + params.clearance + 1) * 2;
	const along = Math.max(w, h);
	// 板子太小就不切了，否则围框剩不下多少
	const width = toUnits(params.notchWidth);
	if (along < width * 2.5) {
		return [];
	}
	return w >= h
		? [rect(cx, box.minY, width, depth), rect(cx, box.maxY, width, depth)]
		: [rect(box.minX, cy, depth, width), rect(box.maxX, cy, depth, width)];
}

// 在板子的尖角处给围框挖一个小圆，避免打印内角发胖卡不进去
function reliefCuts(board: Paths, params: StencilParams): Paths {
	const radius = toUnits(params.clearance + Math.max(0.5, params.nozzle * 1.25));
	const minEdge = 0.3 * SCALE;
	const cuts: Paths = [];
	for (const path of board) {
		if (pathArea(path) <= 0) {
			continue;
		}
		const n = path.length;
		for (let i = 0; i < n; i++) {
			const prev = path[(i + n - 1) % n];
			const cur = path[i];
			const next = path[(i + 1) % n];
			const ax = cur.X - prev.X;
			const ay = cur.Y - prev.Y;
			const bx = next.X - cur.X;
			const by = next.Y - cur.Y;
			const la = Math.hypot(ax, ay);
			const lb = Math.hypot(bx, by);
			if (la < minEdge || lb < minEdge) {
				continue; // 圆弧离散出来的小段不算尖角
			}
			const cross = ax * by - ay * bx;
			const turn = Math.atan2(cross, ax * bx + ay * by);
			// 外轮廓逆时针，左转且转角够大才是凸尖角
			if (turn > (40 * Math.PI) / 180) {
				cuts.push(circle(cur.X, cur.Y, radius, 24));
			}
		}
	}
	return cuts;
}

export interface NozzlePreset {
	nozzle: number;
	thickness: number;
	compensation: number;
	clearance: number;
	// 切片建议
	layerHeight: number;
	lineWidth: number;
	// 这个喷嘴大概能做到的最小脚距（mm）
	minPitch: number;
}

// 换喷嘴时一起带出来的推荐值，都是经验数。
// 细喷嘴钢网薄、孔会打小一点所以略放大；粗喷嘴钢网厚锡膏多，孔缩小刚好抵掉，不用补
export const NOZZLE_PRESETS: NozzlePreset[] = [
	{ nozzle: 0.2, thickness: 0.12, compensation: 0.03, clearance: 0.1, layerHeight: 0.12, lineWidth: 0.22, minPitch: 0.4 },
	{ nozzle: 0.25, thickness: 0.14, compensation: 0.02, clearance: 0.12, layerHeight: 0.14, lineWidth: 0.27, minPitch: 0.5 },
	{ nozzle: 0.4, thickness: 0.2, compensation: 0, clearance: 0.15, layerHeight: 0.2, lineWidth: 0.42, minPitch: 0.65 },
	{ nozzle: 0.6, thickness: 0.24, compensation: 0, clearance: 0.2, layerHeight: 0.24, lineWidth: 0.62, minPitch: 1.27 },
];

export const NOZZLE_RANGE = { min: 0.1, max: 1.2 };

/** 常见喷嘴直接查表，别的尺寸（0.3、0.5、0.8…）在相邻两档之间按比例插值 */
export function nozzlePreset(nozzle: number): NozzlePreset {
	const value = Math.min(NOZZLE_RANGE.max, Math.max(NOZZLE_RANGE.min, nozzle));
	const exact = NOZZLE_PRESETS.find(p => Math.abs(p.nozzle - value) < 1e-6);
	if (exact) {
		return exact;
	}
	// 表外的按最近一段外推
	const i = Math.min(NOZZLE_PRESETS.length - 2, Math.max(0, NOZZLE_PRESETS.findIndex(p => p.nozzle > value) - 1));
	const a = NOZZLE_PRESETS[i];
	const b = NOZZLE_PRESETS[i + 1];
	const k = (value - a.nozzle) / (b.nozzle - a.nozzle);
	const mix = (key: Exclude<keyof NozzlePreset, 'nozzle'>, min = 0) => Math.max(min, round(a[key] + (b[key] - a[key]) * k));
	return {
		nozzle: round(value),
		thickness: mix('thickness', 0.06),
		compensation: mix('compensation'),
		clearance: mix('clearance', 0.05),
		layerHeight: mix('layerHeight', 0.04),
		lineWidth: mix('lineWidth', 0.1),
		minPitch: mix('minPitch', 0.2),
	};
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

export function applyNozzle(params: StencilParams, nozzle: number): StencilParams {
	const preset = nozzlePreset(nozzle);
	// 合并成条是冲着某个喷嘴打不出单孔才开的，换了喷嘴让检查按新喷嘴重新判断
	const mergeRows = preset.nozzle === params.nozzle && params.mergeRows;
	return { ...params, nozzle: preset.nozzle, thickness: preset.thickness, compensation: preset.compensation, clearance: preset.clearance, mergeRows };
}
