// 演示板，46×32 圆角。网页版「加载示例」和测试都用它
import type { GerberSources } from './index';

const HEADER = '%FSLAX45Y45*%\n%MOMM*%\n%LPD*%\n';

function coord(v: number): string {
	return String(Math.round(v * 1e5));
}

class Layer {
	private readonly lines: string[] = [HEADER];
	private readonly apertures = new Map<string, number>();
	private next = 10;

	aperture(definition: string): number {
		let id = this.apertures.get(definition);
		if (id === undefined) {
			id = this.next++;
			this.apertures.set(definition, id);
			this.lines.push(`%ADD${id}${definition}*%\n`);
		}
		return id;
	}

	raw(text: string): void {
		this.lines.push(text);
	}

	flash(definition: string, x: number, y: number): void {
		this.lines.push(`D${this.aperture(definition)}*\nX${coord(x)}Y${coord(y)}D03*\n`);
	}

	rectPad(x: number, y: number, w: number, h: number): void {
		this.flash(`R,${w.toFixed(3)}X${h.toFixed(3)}`, x, y);
	}

	// 圆角矩形焊盘，用光圈宏画（顺便覆盖宏解析）
	roundPad(x: number, y: number, w: number, h: number, r: number): void {
		this.flash(`RoundRect,${w.toFixed(3)}X${h.toFixed(3)}X${r.toFixed(3)}`, x, y);
	}

	toString(): string {
		return `${this.lines.join('')}M02*\n`;
	}
}

const ROUND_RECT_MACRO = [
	'%AMRoundRect*',
	'0 Rounded rectangle: $1 width, $2 height, $3 corner radius*',
	'$4=$1/2-$3*',
	'$5=$2/2-$3*',
	'21,1,$1,$2-2x$3,0,0,0*',
	'21,1,$1-2x$3,$2,0,0,0*',
	'1,1,2x$3,$4,$5*',
	'1,1,2x$3,0-$4,$5*',
	'1,1,2x$3,$4,0-$5*',
	'1,1,2x$3,0-$4,0-$5*%\n',
].join('\n');

const W = 46;
const H = 32;
const R = 3;

function outline(): string {
	const layer = new Layer();
	const d = layer.aperture('C,0.100');
	const c = coord;
	layer.raw([
		`D${d}*`,
		'G75*',
		`G01X${c(R)}Y0D02*`,
		`X${c(W - R)}Y0D01*`,
		`G03X${c(W)}Y${c(R)}I0J${c(R)}D01*`,
		`G01X${c(W)}Y${c(H - R)}D01*`,
		`G03X${c(W - R)}Y${c(H)}I${c(-R)}J0D01*`,
		`G01X${c(R)}Y${c(H)}D01*`,
		`G03X0Y${c(H - R)}I0J${c(-R)}D01*`,
		`G01X0Y${c(R)}D01*`,
		`G03X${c(R)}Y0I${c(R)}J0D01*`,
		'',
	].join('\n'));
	return layer.toString();
}

function chip(layer: Layer, x: number, y: number, pitch: number, w: number, h: number, vertical = false): void {
	const dx = vertical ? 0 : pitch / 2;
	const dy = vertical ? pitch / 2 : 0;
	const pw = vertical ? h : w;
	const ph = vertical ? w : h;
	layer.roundPad(x - dx, y - dy, pw, ph, 0.12);
	layer.roundPad(x + dx, y + dy, pw, ph, 0.12);
}

function quad(layer: Layer, cx: number, cy: number, pinsPerSide: number, pitch: number, span: number, padW: number, padL: number): void {
	const start = -((pinsPerSide - 1) * pitch) / 2;
	for (let i = 0; i < pinsPerSide; i++) {
		const t = start + i * pitch;
		layer.rectPad(cx + t, cy - span / 2, padW, padL);
		layer.rectPad(cx + t, cy + span / 2, padW, padL);
		layer.rectPad(cx - span / 2, cy + t, padL, padW);
		layer.rectPad(cx + span / 2, cy + t, padL, padW);
	}
}

function topPaste(): string {
	const layer = new Layer();
	layer.raw(ROUND_RECT_MACRO);

	// LQFP-48，0.5mm 间距
	quad(layer, 17, 17, 12, 0.5, 8.4, 0.27, 1.3);

	// QFN-20，0.4mm 间距，中间散热焊盘拆成 2×2 小窗
	quad(layer, 33.5, 20.5, 5, 0.4, 3.9, 0.2, 0.7);
	for (const sx of [-0.6, 0.6]) {
		for (const sy of [-0.6, 0.6]) {
			layer.rectPad(33.5 + sx, 20.5 + sy, 0.9, 0.9);
		}
	}

	// USB Type-C 16P 一排细脚 + 两个固定脚
	for (let i = 0; i < 12; i++) {
		layer.rectPad(27.75 + i * 0.5, 2.1, 0.28, 1.1);
	}
	for (const x of [26.2, 34.8]) {
		layer.flash('O,1.000X2.000', x, 2.6);
	}

	// 0603 阻容
	for (let i = 0; i < 6; i++) {
		chip(layer, 6 + i * 3.1, 27.5, 1.6, 0.8, 0.9);
	}
	for (let i = 0; i < 4; i++) {
		chip(layer, 4.2, 9 + i * 3.4, 1.6, 0.8, 0.9, true);
	}
	// 0402
	for (let i = 0; i < 5; i++) {
		chip(layer, 27 + i * 2.1, 27.8, 1.0, 0.5, 0.55);
	}

	// SOT-23
	layer.rectPad(40.2, 11.05, 1.0, 0.6);
	layer.rectPad(40.2, 12.95, 1.0, 0.6);
	layer.rectPad(42.4, 12.0, 1.0, 0.6);

	// SOIC-8
	for (let i = 0; i < 4; i++) {
		layer.roundPad(8.6 + i * 1.27, 4.1, 0.6, 1.55, 0.15);
		layer.roundPad(8.6 + i * 1.27, 9.5, 0.6, 1.55, 0.15);
	}

	// 钽电容 + LED
	layer.rectPad(39.2, 26.5, 1.4, 2.2);
	layer.rectPad(42.4, 26.5, 1.4, 2.2);
	layer.flash('C,1.200', 41, 5.2);
	layer.flash('C,1.200', 41, 7.4);

	// 一块用区域（G36/G37）画的异形焊盘
	const c = coord;
	layer.raw([
		'G36*',
		`G01X${c(19.5)}Y${c(3.2)}D02*`,
		`X${c(23)}Y${c(3.2)}D01*`,
		`X${c(23)}Y${c(5.4)}D01*`,
		`X${c(21.4)}Y${c(5.4)}D01*`,
		`X${c(21.4)}Y${c(4.3)}D01*`,
		`X${c(19.5)}Y${c(4.3)}D01*`,
		`X${c(19.5)}Y${c(3.2)}D01*`,
		'G37*',
		'',
	].join('\n'));
	return layer.toString();
}

function bottomPaste(): string {
	const layer = new Layer();
	layer.raw(ROUND_RECT_MACRO);
	for (let i = 0; i < 8; i++) {
		chip(layer, 8 + i * 4, 8, 1.6, 0.8, 0.9, true);
	}
	for (let i = 0; i < 4; i++) {
		layer.roundPad(12 + i * 1.27, 18, 0.6, 1.55, 0.15);
		layer.roundPad(12 + i * 1.27, 23.4, 0.6, 1.55, 0.15);
	}
	layer.rectPad(30, 20, 2.2, 2.6);
	layer.rectPad(35, 20, 2.2, 2.6);
	return layer.toString();
}

export function demoGerbers(): GerberSources {
	return { outline: outline(), topPaste: topPaste(), bottomPaste: bottomPaste() };
}

export const DEMO_BOARD = { width: W, height: H, cornerRadius: R };
