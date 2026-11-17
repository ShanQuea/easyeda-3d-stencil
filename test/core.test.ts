import { describe, expect, it } from 'vitest';
import {
	analyze,
	applyNozzle,
	area,
	bounds,
	buildMesh,
	buildStencil,
	chainLoops,
	DEFAULT_PARAMS,
	detectLayer,
	difference,
	evaluateExpression,
	extractOutline,
	flattenImage,
	generateStencil,
	inspectMesh,
	loadBoard,
	NOZZLE_PRESETS,
	nozzlePreset,
	parseGerber,
	pickLayers,
	rect,
	to3mf,
	toStl,
} from '../src/core';
import { DEMO_BOARD, demoGerbers } from '../src/core/demo';

const HEAD = '%FSLAX45Y45*%%MOMM*%%LPD*%';

function areaOf(gerber: string): number {
	return area(flattenImage(parseGerber(gerber)));
}

describe('gerber parser', () => {
	it('flashes standard apertures', () => {
		expect(areaOf(`${HEAD}%ADD10R,2X1*%D10*X0Y0D03*M02*`)).toBeCloseTo(2, 3);
		expect(areaOf(`${HEAD}%ADD10C,2*%D10*X100000Y0D03*M02*`)).toBeCloseTo(Math.PI, 1);
		// 长圆 = 矩形 + 两个半圆
		expect(areaOf(`${HEAD}%ADD10O,3X1*%D10*X0Y0D03*M02*`)).toBeCloseTo(2 + Math.PI / 4, 1);
		// 带孔的圆
		expect(areaOf(`${HEAD}%ADD10C,2X1*%D10*X0Y0D03*M02*`)).toBeCloseTo(Math.PI * 0.75, 1);
	});

	it('handles inch units and trailing-zero omission', () => {
		expect(areaOf('%FSLAX24Y24*%%MOIN*%%ADD10R,0.1X0.1*%D10*X10000Y10000D03*M02*')).toBeCloseTo(2.54 * 2.54, 2);
		const image = parseGerber('%FSTAX23Y23*%%MOMM*%%ADD10R,1X1*%D10*X15Y2D03*M02*');
		const box = bounds(flattenImage(image))!;
		expect((box.minX + box.maxX) / 2).toBe(15000);
		expect((box.minY + box.maxY) / 2).toBe(20000);
	});

	it('evaluates macro expressions', () => {
		const vars = new Map([[1, 2], [2, 3]]);
		expect(evaluateExpression('$1x$2+1', vars)).toBe(7);
		expect(evaluateExpression('($1+$2)/2-0.5', vars)).toBe(2);
		expect(evaluateExpression('0-$1', vars)).toBe(-2);
		expect(evaluateExpression('-$2x2', vars)).toBe(-6);
	});

	it('builds aperture macros with exposure off', () => {
		// 2x2 方块中间挖掉直径 1 的圆
		const macro = '%AMDONUT*21,1,$1,$1,0,0,0*1,0,$2,0,0*%';
		expect(areaOf(`${HEAD}${macro}%ADD10DONUT,2X1*%D10*X0Y0D03*M02*`)).toBeCloseTo(4 - Math.PI / 4, 1);
		// 旋转 45° 的矩形面积不变，包围盒变大
		const rotated = parseGerber(`${HEAD}%AMROT*21,1,2,1,0,0,45*%%ADD10ROT*%D10*X0Y0D03*M02*`);
		expect(area(flattenImage(rotated))).toBeCloseTo(2, 2);
		expect(bounds(flattenImage(rotated))!.maxX).toBeGreaterThan(1050);
	});

	it('draws strokes, arcs and regions', () => {
		// 线宽 1、长 10 的线 = 10 + 圆头
		expect(areaOf(`${HEAD}%ADD10C,1*%D10*X0Y0D02*X1000000Y0D01*M02*`)).toBeCloseTo(10 + Math.PI / 4, 1);
		// 区域：半径 5 的整圆
		expect(areaOf(`${HEAD}G75*G36*X500000Y0D02*G03X500000Y0I-500000J0D01*G37*M02*`)).toBeCloseTo(Math.PI * 25, 0);
		// 单象限模式的四分之一圆扇形
		const quarter = `${HEAD}G74*G36*X0Y0D02*G01X500000Y0D01*G03X0Y500000I500000J0D01*G01X0Y0D01*G37*M02*`;
		expect(areaOf(quarter)).toBeCloseTo((Math.PI * 25) / 4, 0);
	});

	it('applies clear polarity and step-repeat', () => {
		expect(areaOf(`${HEAD}%ADD10R,4X4*%%ADD11R,2X2*%D10*X0Y0D03*%LPC*%D11*X0Y0D03*M02*`)).toBeCloseTo(12, 3);
		expect(areaOf(`${HEAD}%ADD10R,1X1*%%SRX3Y2I2J2*%D10*X0Y0D03*%SR*%M02*`)).toBeCloseTo(6, 3);
	});

	it('reuses the previous operation when the D code is omitted', () => {
		const image = parseGerber(`${HEAD}%ADD10C,0.2*%D10*X0Y0D02*X100000Y0D01*X100000Y100000*X0Y100000*X0Y0*M02*`);
		expect(image.tracks).toHaveLength(1);
		expect(image.tracks[0].points).toHaveLength(5);
	});
});

describe('board outline', () => {
	it('chains unordered segments into a loop', () => {
		const loops = chainLoops([
			[{ X: 0, Y: 0 }, { X: 1000, Y: 0 }],
			[{ X: 1000, Y: 1000 }, { X: 1000, Y: 1 }],
			[{ X: 1000, Y: 1000 }, { X: 0, Y: 1000 }],
			[{ X: 0, Y: 0 }, { X: 0, Y: 1000 }],
		], 2);
		expect(loops).toHaveLength(1);
		expect(Math.abs(area(loops))).toBeCloseTo(1, 2);
	});

	it('recovers the centreline of the demo outline', () => {
		const outline = extractOutline(parseGerber(demoGerbers().outline!));
		expect(outline.method).toBe('chained');
		const { width, height, cornerRadius: r } = DEMO_BOARD;
		expect(area(outline.board)).toBeCloseTo(width * height - (4 - Math.PI) * r * r, 0);
	});

	it('treats nested loops as cutouts and falls back gracefully', () => {
		const square = (s: number): string => `X-${s}Y-${s}D02*X${s}Y-${s}D01*X${s}Y${s}D01*X-${s}Y${s}D01*X-${s}Y-${s}D01*`;
		const nested = extractOutline(parseGerber(`${HEAD}%ADD10C,0.1*%D10*${square(1000000)}${square(200000)}M02*`));
		expect(area(nested.board)).toBeCloseTo(400, 1);
		expect(nested.cutouts).toHaveLength(1);

		// 标准版转过来的板框会有 0.02mm 的缝，里面的圆孔先成环也不能把外框挤掉
		const gap = extractOutline(parseGerber(`${HEAD}%ADD10C,0.25*%D10*X0Y0D02*X2000000Y0D01*X2000000Y0D02*X2000000Y1000000D01*`
			+ `X2000000Y1000000D02*X2000Y1000000D01*X0Y1000000D02*X0Y0D01*G75*X300000Y500000D02*G03X300000Y500000I50000J0D01*M02*`));
		expect(gap.method).toBe('chained');
		expect(area(gap.board)).toBeCloseTo(200, 0);
		expect(gap.cutouts).toHaveLength(1);

		// 缺一条边：串不成环，退回包围盒
		const open = extractOutline(parseGerber(`${HEAD}%ADD10C,0.1*%D10*X0Y0D02*X1000000Y0D01*X1000000Y500000D01*X0Y500000D01*M02*`));
		expect(open.method).toBe('bbox');
		expect(area(open.board)).toBeCloseTo(50, 1);

		// 完全没有板框：用锡膏层的范围兜底
		const none = extractOutline(parseGerber(''), [rect(0, 0, 10000, 10000)]);
		expect(none.method).toBe('bbox');
		expect(area(none.board)).toBeCloseTo(14 * 14, 1);
	});

	it('detects layers by file name', () => {
		expect(detectLayer('Gerber_TopPasteMaskLayer.GTP')).toBe('topPaste');
		expect(detectLayer('Gerber_BottomPasteMaskLayer.GBP')).toBe('bottomPaste');
		expect(detectLayer('Gerber_BoardOutlineLayer.GKO')).toBe('outline');
		expect(detectLayer('board-F_Paste.gbr')).toBe('topPaste');
		expect(detectLayer('board-B_Paste.gbr')).toBe('bottomPaste');
		expect(detectLayer('board-Edge_Cuts.gbr')).toBe('outline');
		expect(detectLayer('Gerber_TopSolderMaskLayer.GTS')).toBeUndefined();
		expect(detectLayer('Gerber_TopLayer.GTL')).toBeUndefined();
		const picked = pickLayers(['a/x.GTL', 'a/x.GTP', 'a/x.GKO', 'a/x.GM1', 'a/x.GBP']);
		expect(picked).toEqual({ topPaste: 'a/x.GTP', bottomPaste: 'a/x.GBP', outline: 'a/x.GKO' });
	});
});

describe('mesher', () => {
	it('produces a watertight box', () => {
		const mesh = buildMesh([{ paths: [rect(0, 0, 10000, 20000)], height: 2 }]);
		const report = inspectMesh(mesh);
		expect(report.badEdges).toBe(0);
		expect(report.volume).toBeCloseTo(400, 3);
	});

	it('handles stepped regions that share and partially share edges', () => {
		const mesh = buildMesh([
			{ paths: [rect(0, 0, 10000, 10000)], height: 1 },
			// 紧贴右侧、只占一半高度的台阶，共享边上有 T 形接点
			{ paths: [rect(7500, 2500, 5000, 5000)], height: 3 },
		]);
		const report = inspectMesh(mesh);
		expect(report.badEdges).toBe(0);
		expect(report.volume).toBeCloseTo(100 + 75, 3);
	});
});

describe('stencil end to end', () => {
	const data = loadBoard(demoGerbers());

	it('loads the demo board', () => {
		expect(data.outlineMethod).toBe('chained');
		expect(data.warnings).toEqual([]);
		expect(data.paste.top.length).toBeGreaterThan(100);
		expect(data.paste.bottom.length).toBeGreaterThan(10);
	});

	for (const frameMode of ['full', 'corners', 'none'] as const) {
		for (const side of ['top', 'bottom'] as const) {
			it(`generates a manifold ${side} stencil (${frameMode})`, () => {
				const params = { ...DEFAULT_PARAMS, side, frameMode };
				const { model, mesh, analysis } = generateStencil(data, params);
				const report = inspectMesh(mesh);
				expect(report.badEdges).toBe(0);
				expect(report.triangleCount).toBeGreaterThan(500);

				// 体积 = 各区域面积 × 高度
				const expected = model.regions.reduce((sum, r) => sum + area(r.paths) * r.height, 0);
				expect(report.volume / expected).toBeCloseTo(1, 3);

				expect(model.mirrored).toBe(side === 'top');
				expect(analysis.apertureCount).toBe(data.paste[side].length);
				expect(model.frame.length > 0).toBe(frameMode !== 'none');
				expect(analysis.height).toBeCloseTo(frameMode === 'none' ? 0.2 : 1.6, 6);
			});
		}
	}

	it('mirrors the top side only', () => {
		// 演示板的 Type-C 在右下，顶层钢网镜像后应该跑到左边
		const top = generateStencil(data, { ...DEFAULT_PARAMS, side: 'top' }).model;
		const noFrame = generateStencil(data, { ...DEFAULT_PARAMS, side: 'top', frameMode: 'none' }).model;
		expect(area(top.apertures)).toBeCloseTo(area(noFrame.apertures), 6);
		const sourceBox = bounds(data.paste.top)!;
		const modelBox = bounds(top.apertures)!;
		// 镜像后包围盒宽度不变
		expect(modelBox.maxX - modelBox.minX).toBe(sourceBox.maxX - sourceBox.minX);
		const sourceLeftGap = sourceBox.minX - bounds(data.board)!.minX;
		const modelRightGap = bounds(top.board)!.maxX - modelBox.maxX;
		expect(modelRightGap).toBe(sourceLeftGap);
	});

	it('flags fine-pitch parts for a 0.4 nozzle but not a 0.2 nozzle', () => {
		const coarse = generateStencil(data, { ...DEFAULT_PARAMS, nozzle: 0.4 });
		expect(coarse.analysis.narrowApertures).toBeGreaterThan(10);
		const fine = generateStencil(data, { ...DEFAULT_PARAMS, nozzle: 0.2 });
		expect(fine.analysis.narrowApertures).toBe(0);
		const again = analyze(fine.model, { ...DEFAULT_PARAMS, nozzle: 0.2 });
		expect(again.issues).toHaveLength(again.narrowApertures + again.thinWebs);
	});

	it('compensation changes aperture area', () => {
		const base = generateStencil(data, DEFAULT_PARAMS).analysis.apertureArea;
		const shrunk = generateStencil(data, { ...DEFAULT_PARAMS, compensation: -0.05 }).analysis.apertureArea;
		const grown = generateStencil(data, { ...DEFAULT_PARAMS, compensation: 0.05 }).analysis.apertureArea;
		expect(shrunk).toBeLessThan(base);
		expect(grown).toBeGreaterThan(base);
	});

	it('exports STL and 3MF', async () => {
		const { mesh } = generateStencil(data, DEFAULT_PARAMS);
		const stl = toStl(mesh);
		const count = mesh.triangles.length / 3;
		expect(stl.byteLength).toBe(84 + count * 50);
		expect(new DataView(stl).getUint32(80, true)).toBe(count);

		const zip = new Uint8Array(await to3mf(mesh));
		expect(String.fromCharCode(zip[0], zip[1])).toBe('PK');
		expect(zip.byteLength).toBeGreaterThan(1000);
	});
});

describe('web keeping', () => {
	// 两个 0.3×1 的焊盘，中间只隔 0.15
	const pads = [rect(-225, 0, 300, 1000), rect(225, 0, 300, 1000)];
	const boardOutline = [rect(0, 0, 10000, 10000)];
	const base = { ...DEFAULT_PARAMS, side: 'bottom' as const, frameMode: 'none' as const, nozzle: 0.2 };

	it('trims both neighbours so the web reaches one line width', () => {
		const model = buildStencil(boardOutline, pads, { ...base, keepWebs: true });
		expect(model.webFix.count).toBe(2);
		expect(model.webFix.maxShrink).toBeCloseTo(0.025, 2);
		const [left, right] = model.apertures.map(p => bounds([p])!).sort((a, b) => a.minX - b.minX);
		expect((right.minX - left.maxX) / 1000).toBeCloseTo(0.2, 2);
		// 外侧的边不动
		expect(left.minX).toBe(-375);
		expect(right.maxX).toBe(375);
		expect(inspectMesh(buildMesh(model.regions)).badEdges).toBe(0);
	});

	it('does not trim apertures that would end up clogged', () => {
		// 0.4 喷嘴下 0.3 宽的孔已经在极限了，再削就没了
		const model = buildStencil(boardOutline, pads, { ...base, nozzle: 0.4, keepWebs: true });
		expect(model.webFix.count).toBe(0);
		expect(area(model.apertures)).toBeCloseTo(0.6, 3);
	});

	it('ignores the notch inside a single pad', () => {
		// 1×1 的焊盘中间开一条 0.15 宽的缺口，像嘉立创的防立碑开窗
		const notched = difference([rect(0, 0, 1000, 1000)], [rect(0, 300, 150, 600)]);
		const model = buildStencil(boardOutline, notched, { ...base, keepWebs: true });
		expect(model.webFix.count).toBe(0);
		expect(area(model.apertures)).toBeCloseTo(area(notched), 3);
	});

	it('leaves things alone when off or when the web is already wide enough', () => {
		const off = buildStencil(boardOutline, pads, { ...base, keepWebs: false });
		expect(off.webFix.count).toBe(0);
		expect(area(off.apertures)).toBeCloseTo(0.6, 3);
		const wide = buildStencil(boardOutline, [rect(-400, 0, 300, 1000), rect(400, 0, 300, 1000)], { ...base, keepWebs: true });
		expect(wide.webFix.count).toBe(0);
	});
});

describe('nozzle presets', () => {
	it('swaps the nozzle-dependent defaults only', () => {
		const fine = applyNozzle({ ...DEFAULT_PARAMS, boardThickness: 1.0, frameMode: 'corners' }, 0.2);
		expect(fine).toMatchObject({ nozzle: 0.2, thickness: 0.12, clearance: 0.1, boardThickness: 1.0, frameMode: 'corners' });
		expect(applyNozzle(fine, 0.4)).toMatchObject({ thickness: DEFAULT_PARAMS.thickness, compensation: DEFAULT_PARAMS.compensation, clearance: DEFAULT_PARAMS.clearance });
		// 表外的喷嘴不再取最近一档，按相邻两档插值
		expect(nozzlePreset(0.3)).toMatchObject({ nozzle: 0.3, thickness: 0.16, minPitch: 0.55 });
		expect(applyNozzle(DEFAULT_PARAMS, 0.5)).toMatchObject({ nozzle: 0.5, thickness: 0.22 });
		expect(nozzlePreset(0.8).minPitch).toBeGreaterThan(nozzlePreset(0.6).minPitch);
	});

	it('every preset yields a printable manifold mesh', () => {
		const data = loadBoard(demoGerbers());
		for (const preset of NOZZLE_PRESETS) {
			const { mesh, analysis } = generateStencil(data, applyNozzle(DEFAULT_PARAMS, preset.nozzle));
			expect(inspectMesh(mesh).badEdges).toBe(0);
			expect(analysis.minOpening).toBeCloseTo(preset.nozzle * 0.75, 6);
		}
	});
});
