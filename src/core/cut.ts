// 激光切割用的二维文件：外形一种颜色，开孔一种颜色，
// LightBurn、RDWorks 这类软件按颜色分图层，可以分别设速度功率
import type { Paths } from './geom';
import { bounds, toMm } from './geom';

export interface CutSheet {
	outline: Paths;
	apertures: Paths;
}

function layers(sheet: CutSheet): Array<{ name: string; paths: Paths; svg: string; dxf: number }> {
	return [
		{ name: 'OUTLINE', paths: sheet.outline, svg: '#0000ff', dxf: 5 },
		{ name: 'APERTURES', paths: sheet.apertures, svg: '#ff0000', dxf: 1 },
	];
}

// 左下角挪到原点，切割软件里好摆
function origin(sheet: CutSheet): { x: number; y: number; w: number; h: number } {
	const box = bounds([...sheet.outline, ...sheet.apertures]) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	return { x: box.minX, y: box.minY, w: toMm(box.maxX - box.minX), h: toMm(box.maxY - box.minY) };
}

const num = (v: number): string => String(Math.round(v * 10000) / 10000);

export function toSvg(sheet: CutSheet): string {
	const o = origin(sheet);
	const out = [
		'<?xml version="1.0" encoding="UTF-8"?>\n',
		`<svg xmlns="http://www.w3.org/2000/svg" width="${num(o.w)}mm" height="${num(o.h)}mm" viewBox="0 0 ${num(o.w)} ${num(o.h)}">\n`,
	];
	for (const layer of layers(sheet)) {
		const d = layer.paths
			.map(path => `M${path.map(p => `${num(toMm(p.X - o.x))} ${num(o.h - toMm(p.Y - o.y))}`).join('L')}Z`)
			.join('');
		if (d) {
			out.push(` <path id="${layer.name.toLowerCase()}" fill="none" stroke="${layer.svg}" stroke-width="0.05" d="${d}"/>\n`);
		}
	}
	out.push('</svg>\n');
	return out.join('');
}

// R12 的 POLYLINE，老软件新软件都认
export function toDxf(sheet: CutSheet): string {
	const o = origin(sheet);
	const out: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
	for (const layer of layers(sheet)) {
		for (const path of layer.paths) {
			out.push('0', 'POLYLINE', '8', layer.name, '62', String(layer.dxf), '66', '1', '70', '1', '10', '0', '20', '0', '30', '0');
			for (const p of path) {
				out.push('0', 'VERTEX', '8', layer.name, '10', num(toMm(p.X - o.x)), '20', num(toMm(p.Y - o.y)), '30', '0');
			}
			out.push('0', 'SEQEND', '8', layer.name);
		}
	}
	out.push('0', 'ENDSEC', '0', 'EOF');
	return `${out.join('\n')}\n`;
}
