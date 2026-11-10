// FDM 线宽约等于喷嘴直径：孔太窄会糊死，孔之间的筋太细打不出来（会连锡）
import type { Paths } from './geom';
import type { StencilModel, StencilParams } from './stencil';
import { area, bounds, difference, islands, offset, pathArea, toMm } from './geom';

export type IssueKind = 'narrowAperture' | 'thinWeb';

export interface Issue {
	kind: IssueKind;
	x: number;
	y: number;
}

export interface Analysis {
	issues: Issue[];
	apertureCount: number;
	narrowApertures: number;
	thinWebs: number;
	apertureArea: number;
	pasteVolume: number;
	width: number;
	depth: number;
	height: number;
	minOpening: number;
	minWeb: number;
}

function center(paths: Paths): { x: number; y: number } {
	const box = bounds(paths)!;
	return { x: toMm((box.minX + box.maxX) / 2), y: toMm((box.minY + box.maxY) / 2) };
}

export function analyze(model: StencilModel, params: StencilParams): Analysis {
	// 现代切片的可变线宽能把窄筋挤到约半个喷嘴宽；开孔窄于 3/4 喷嘴基本会糊死
	const minOpening = params.nozzle * 0.75;
	const minWeb = params.nozzle * 0.5;
	const issues: Issue[] = [];

	const apertureIslands = islands(model.apertures);
	let narrowApertures = 0;
	for (const island of apertureIslands) {
		const shape = [island.outer, ...island.holes];
		// 向内缩半个最小宽度后什么都不剩，说明这个孔比最小宽度还窄
		if (!offset(shape, -minOpening / 2, 'miter').length) {
			narrowApertures++;
			issues.push({ kind: 'narrowAperture', ...center([island.outer]) });
		}
	}

	// 开运算（先缩后扩）会抹掉所有窄于 minWeb 的部分，和原图一减就是细筋
	const material = difference(model.board, model.apertures);
	const opened = offset(offset(material, -minWeb / 2, 'round'), minWeb / 2, 'round');
	const residue = difference(material, opened);
	let thinWebs = 0;
	// 尖角处也会留下一点点残渣，按面积滤掉
	const minResidue = minWeb * minWeb * 0.5;
	for (const piece of residue) {
		if (pathArea(piece) >= minResidue) {
			thinWebs++;
			issues.push({ kind: 'thinWeb', ...center([piece]) });
		}
	}

	const apertureArea = area(model.apertures);
	const box = model.bounds;
	return {
		issues,
		apertureCount: apertureIslands.length,
		narrowApertures,
		thinWebs,
		apertureArea,
		pasteVolume: apertureArea * params.thickness,
		width: toMm(box.maxX - box.minX),
		depth: toMm(box.maxY - box.minY),
		height: params.thickness + model.frameHeight,
		minOpening,
		minWeb,
	};
}
