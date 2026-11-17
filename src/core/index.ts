import type { Analysis } from './analyze';
import type { CutSheet } from './cut';
import type { Paths } from './geom';
import type { JigModel } from './jig';
import type { Mesh } from './mesh';
import type { OutlineMethod } from './outline';
import type { Side, StencilModel, StencilParams } from './stencil';
import { analyze } from './analyze';
import { mirrorX } from './geom';
import { flattenImage, parseGerber } from './gerber';
import { buildJig } from './jig';
import { buildMesh } from './mesh';
import { extractOutline } from './outline';
import { buildStencil } from './stencil';

export * from './analyze';
export * from './cut';
export * from './export';
export * from './geom';
export * from './gerber';
export * from './jig';
export * from './layers';
export * from './mesh';
export * from './outline';
export * from './stencil';
export * from './strips';

export interface GerberSources {
	outline?: string;
	topPaste?: string;
	bottomPaste?: string;
}

export interface BoardData {
	board: Paths;
	cutouts: Paths;
	outlineMethod: OutlineMethod;
	paste: Record<Side, Paths>;
	warnings: string[];
}

export interface StencilResult {
	model: StencilModel;
	mesh: Mesh;
	analysis: Analysis;
}

export function loadBoard(sources: GerberSources): BoardData {
	const warnings: string[] = [];
	const paste: Record<Side, Paths> = { top: [], bottom: [] };
	for (const side of ['top', 'bottom'] as const) {
		const text = side === 'top' ? sources.topPaste : sources.bottomPaste;
		if (text) {
			const image = parseGerber(text);
			warnings.push(...image.warnings);
			paste[side] = flattenImage(image);
		}
	}
	const outlineImage = parseGerber(sources.outline ?? '');
	warnings.push(...outlineImage.warnings);
	const outline = extractOutline(outlineImage, [...paste.top, ...paste.bottom]);
	return { board: outline.board, cutouts: outline.cutouts, outlineMethod: outline.method, paste, warnings: Array.from(new Set(warnings)) };
}

// 激光切割不受喷嘴限制：开孔按原样出，不合并、不削筋、不补偿；平片也没有围框
export function effectiveParams(params: StencilParams): StencilParams {
	if (params.method !== 'laser') {
		return params;
	}
	return { ...params, compensation: 0, mergeRows: false, keepWebs: false, frameMode: 'none' };
}

export function generateStencil(data: BoardData, params: StencilParams): StencilResult {
	const used = effectiveParams(params);
	const model = buildStencil(data.board, data.paste[used.side], used);
	const mesh = buildMesh(model.regions);
	const analysis = analyze(model, used);
	if (used.method === 'laser') {
		analysis.issues = [];
		analysis.narrowApertures = 0;
		analysis.thinWebs = 0;
	}
	return { model, mesh, analysis };
}

// 切割图按使用姿态（从要刷锡的那面看过去）
export function cutSheet(model: StencilModel): CutSheet {
	return { outline: mirrorX(model.plate), apertures: mirrorX(model.apertures) };
}

export interface JigResult {
	model: JigModel;
	mesh: Mesh;
}

export function generateJig(data: BoardData, params: StencilParams): JigResult {
	const model = buildJig(data.board, data.paste[params.side], params);
	return { model, mesh: buildMesh(model.regions) };
}
