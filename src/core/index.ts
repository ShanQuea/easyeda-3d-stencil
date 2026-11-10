import type { Analysis } from './analyze';
import type { Paths } from './geom';
import type { Mesh } from './mesh';
import type { OutlineMethod } from './outline';
import type { Side, StencilModel, StencilParams } from './stencil';
import { analyze } from './analyze';
import { flattenImage, parseGerber } from './gerber';
import { buildMesh } from './mesh';
import { extractOutline } from './outline';
import { buildStencil } from './stencil';

export * from './analyze';
export * from './export';
export * from './geom';
export * from './gerber';
export * from './layers';
export * from './mesh';
export * from './outline';
export * from './stencil';

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

export function generateStencil(data: BoardData, params: StencilParams): StencilResult {
	const model = buildStencil(data.board, data.paste[params.side], params);
	const mesh = buildMesh(model.regions);
	return { model, mesh, analysis: analyze(model, params) };
}
