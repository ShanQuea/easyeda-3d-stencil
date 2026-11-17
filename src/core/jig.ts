// 钢网架：给外面做的无框钢网用（嘉立创那种不锈钢片）。底座上挖两层槽：
// 下层按板框放 PCB，板面和台面齐平；上层按钢网片尺寸，片子放进去开孔正好落在焊盘上。
// 全部按使用姿态（从要刷锡的那面往下看），打印也是这个姿态，凹槽朝上不用支撑
import type { Paths } from './geom';
import type { Side, StencilParams, StencilRegion } from './stencil';
import { bounds, circle, clean, difference, intersection, mirrorX, offset, rect, toMm, toUnits, translate, union } from './geom';

export const JIG = {
	floor: 2,
	// 另一面贴了件时板子架在一圈边上，底下要给元件留高度
	floorSecond: 6,
	ledge: 1.5,
	rim: 5,
	// 钢网槽深度：比片子厚得多，FDM 才打得出这道台阶，四周也卡得住片子
	lip: 1,
	// 钢网片四周留的缝，太紧放不进，太松会晃；目视对位时多留点好挪
	sheetGap: 0.15,
	freeGap: 2,
	// 台面比板面低一点，钢网压在板上而不是悬在台面上
	proud: 0.05,
	// 自动尺寸：板子每边留多少，再往上取整到 10mm
	autoMargin: 15,
};

export interface JigModel {
	regions: StencilRegion[];
	board: Paths;
	apertures: Paths;
	// 钢网片外形（不含开孔）
	sheet: Paths;
	sheetSize: { w: number; h: number; auto: boolean };
	// 钢网边缘到开孔图形的距离（mm），居中时拿来让用户量一下核对
	margins: { left: number; bottom: number };
	floor: number;
	// 台面高度，也就是钢网片底面
	top: number;
	// 钢网片盖不住板子（再留 1mm）时为 false
	fits: boolean;
	width: number;
	depth: number;
	height: number;
}

// 板子摆正：从刷锡那面看，板框中心放原点
function facing(paths: Paths, side: Side, board: Paths): Paths {
	const flipped = side === 'bottom' ? mirrorX(paths) : paths;
	const box = bounds(side === 'bottom' ? mirrorX(board) : board) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	return translate(flipped, -Math.round((box.minX + box.maxX) / 2), -Math.round((box.minY + box.maxY) / 2));
}

export function autoSheetSize(board: Paths): { w: number; h: number } {
	const box = bounds(board) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	const round = (v: number) => Math.ceil((toMm(v) + JIG.autoMargin * 2) / 10) * 10;
	return { w: round(box.maxX - box.minX), h: round(box.maxY - box.minY) };
}

export function buildJig(boardRaw: Paths, paste: Paths, params: StencilParams): JigModel {
	const board = facing(union(boardRaw), params.side, boardRaw);
	const apertures = facing(paste, params.side, boardRaw);
	const auto = autoSheetSize(boardRaw);
	const w = params.sheetWidth > 0 ? params.sheetWidth : auto.w;
	const h = params.sheetHeight > 0 ? params.sheetHeight : auto.h;

	// 片子放哪由开孔图形决定：居中就是图形外接框居中，实测就从图形往外量
	const pattern = bounds(apertures) ?? bounds(board)!;
	let cx = (pattern.minX + pattern.maxX) / 2;
	let cy = (pattern.minY + pattern.maxY) / 2;
	if (params.sheetAlign === 'measure') {
		cx = pattern.minX - toUnits(params.sheetLeft) + toUnits(w) / 2;
		cy = pattern.minY - toUnits(params.sheetBottom) + toUnits(h) / 2;
	}
	cx = Math.round(cx);
	cy = Math.round(cy);
	const sheet = [rect(cx, cy, toUnits(w), toUnits(h))];
	const gap = params.sheetAlign === 'free' ? JIG.freeGap : JIG.sheetGap;
	const recess = [rect(cx, cy, toUnits(w + gap * 2), toUnits(h + gap * 2))];
	const sbox = bounds(sheet)!;
	const margins = { left: toMm(pattern.minX - sbox.minX), bottom: toMm(pattern.minY - sbox.minY) };
	const base = clean(offset(offset(offset(recess, JIG.rim, 'miter'), -3, 'miter'), 3, 'round'));
	const cavity = offset(board, Math.max(0, params.clearance), 'miter');
	const fits = !difference(offset(board, 1, 'miter'), sheet).length;

	const floor = params.secondSide ? JIG.floorSecond : JIG.floor;
	const top = floor + Math.max(0.2, params.boardThickness - JIG.proud);
	const rimTop = top + JIG.lip;

	const cbox = bounds(cavity)!;
	const bw = cbox.maxX - cbox.minX;
	const bh = cbox.maxY - cbox.minY;
	const mid = { x: (cbox.minX + cbox.maxX) / 2, y: (cbox.minY + cbox.maxY) / 2 };
	// 顶板孔：凹槽长边中点挖通，从底下一顶板子就起来
	const r = Math.min(toUnits(6), Math.min(bw, bh) / 6);
	const push = params.secondSide
		? []
		: bw >= bh
			? [circle(mid.x, cbox.minY, r, 48), circle(mid.x, cbox.maxY, r, 48)]
			: [circle(cbox.minX, mid.y, r, 48), circle(cbox.maxX, mid.y, r, 48)];
	// 另一面贴了件：凹槽底挖空，只留一圈边托住板子
	const pocketFloor = params.secondSide ? difference(cavity, offset(cavity, -JIG.ledge, 'miter')) : cavity;

	// 钢网槽左右两边各开一个缺口，手指能把片子抠起来
	const rbox = bounds(recess)!;
	const notchDepth = toUnits(JIG.rim + 1) * 2;
	const notchWidth = toUnits(Math.min(16, h / 3));
	const notches = intersection([rect(rbox.minX, cy, notchDepth, notchWidth), rect(rbox.maxX, cy, notchDepth, notchWidth)], base);

	const holes = union([...cavity, ...push]);
	const regions: StencilRegion[] = [
		{ paths: clean(intersection(difference(pocketFloor, union(push)), base)), height: floor },
		{ paths: clean(difference(intersection(union([...recess, ...notches]), base), holes)), height: top },
		{ paths: clean(difference(base, union([...recess, ...notches, ...holes]))), height: rimTop },
	].filter(region => region.paths.length);

	const box = bounds(base)!;
	return {
		regions,
		board,
		apertures,
		sheet,
		sheetSize: { w, h, auto: !(params.sheetWidth > 0 && params.sheetHeight > 0) },
		margins,
		floor,
		top,
		fits,
		width: toMm(box.maxX - box.minX),
		depth: toMm(box.maxY - box.minY),
		height: rimTop,
	};
}
