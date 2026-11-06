import type { Path, Paths, Pt } from './geom';
import { ARC_TOLERANCE, circle, difference, rect, SCALE, strokePolyline, sweep, translate, union } from './geom';

export interface GerberObject {
	// true = 加材料（LPD），false = 挖除（LPC）
	dark: boolean;
	paths: Paths;
}

export interface GerberTrack {
	points: Path;
	width: number;
	dark: boolean;
}

export interface GerberImage {
	objects: GerberObject[];
	tracks: GerberTrack[];
	flashCount: number;
	regionCount: number;
	unit: 'mm' | 'in';
	warnings: string[];
}

interface Aperture {
	shape: Paths;
	diameter?: number;
}

type MacroStatement
	= | { kind: 'assign'; variable: number; expr: string }
		| { kind: 'primitive'; code: number; exprs: string[] };

interface CoordinateFormat {
	integer: number;
	decimal: number;
	zero: 'L' | 'T';
}

const TWO_PI = Math.PI * 2;

export function flattenImage(image: Pick<GerberImage, 'objects'>): Paths {
	let result: Paths = [];
	let batch: Paths = [];
	let batchDark = true;
	const flush = (): void => {
		if (!batch.length) {
			return;
		}
		result = batchDark ? union(result.concat(batch)) : difference(result, batch);
		batch = [];
	};
	for (const object of image.objects) {
		if (object.dark !== batchDark) {
			flush();
			batchDark = object.dark;
		}
		for (const path of object.paths) {
			batch.push(path);
		}
	}
	flush();
	return result;
}

export function parseGerber(source: string): GerberImage {
	return new GerberParser().parse(source);
}

class GerberParser {
	private readonly image: GerberImage = { objects: [], tracks: [], flashCount: 0, regionCount: 0, unit: 'mm', warnings: [] };
	private readonly apertures = new Map<number, Aperture>();
	private readonly macros = new Map<string, MacroStatement[]>();
	private readonly warned = new Set<string>();

	private format: CoordinateFormat = { integer: 3, decimal: 5, zero: 'L' };
	private unitScale = SCALE;
	private incremental = false;

	private x = 0;
	private y = 0;
	private interpolation: 1 | 2 | 3 = 1;
	private multiQuadrant = true;
	private lastOperation = 0;
	private dark = true;
	private current: Aperture | undefined;

	private inRegion = false;
	private contour: Path = [];
	private stroke: Path = [];

	private repeat: { nx: number; ny: number; dx: number; dy: number; objectStart: number; trackStart: number } | undefined;
	private done = false;

	parse(source: string): GerberImage {
		const text = source.replace(/[\r\n]+/g, '');
		let i = 0;
		while (i < text.length && !this.done) {
			if (text[i] === '%') {
				const end = text.indexOf('%', i + 1);
				const body = text.slice(i + 1, end < 0 ? text.length : end);
				this.extended(body.split('*').map(s => s.trim()).filter(Boolean));
				i = end < 0 ? text.length : end + 1;
			}
			else {
				const end = text.indexOf('*', i);
				const block = text.slice(i, end < 0 ? text.length : end).trim();
				if (block) {
					this.block(block);
				}
				i = end < 0 ? text.length : end + 1;
			}
		}
		this.finish();
		return this.image;
	}

	private warn(message: string): void {
		if (!this.warned.has(message)) {
			this.warned.add(message);
			this.image.warnings.push(message);
		}
	}

	private extended(blocks: string[]): void {
		if (!blocks.length) {
			return;
		}
		const head = blocks[0];
		const code = head.slice(0, 2);
		switch (code) {
			case 'FS': {
				const m = /^FS([LTD]?)([AI]?)X(\d)(\d)Y\d\d/.exec(head);
				if (m) {
					this.format = { zero: m[1] === 'T' ? 'T' : 'L', integer: Number(m[3]), decimal: Number(m[4]) };
					this.incremental = m[2] === 'I';
				}
				else {
					this.warn(`Unrecognized coordinate format: ${head}`);
				}
				break;
			}
			case 'MO':
				this.setUnit(head.slice(2, 4) === 'IN' ? 'in' : 'mm');
				break;
			case 'AD':
				this.defineAperture(head);
				break;
			case 'AM':
				this.defineMacro(head.slice(2), blocks.slice(1));
				break;
			case 'LP':
				this.flushStroke();
				this.dark = head[2] !== 'C';
				break;
			case 'SR':
				this.stepRepeat(head);
				break;
			case 'LM':
			case 'LR':
			case 'LS':
				if (!/^(?:LMN|LR0*(?:\.0*)?|LS1(?:\.0*)?)$/.test(head)) {
					this.warn(`Unsupported aperture transform ${head} (ignored)`);
				}
				break;
			case 'AB':
				this.warn('Block apertures (AB) are not supported (ignored)');
				break;
			default:
				// TF/TA/TO/TD 属性、IP/LN/IN/OF/MI/SF 等对几何没有影响
				break;
		}
		// 一对 % 里可以放多条指令，AM 除外（后续块是宏体）
		if (code !== 'AM' && blocks.length > 1) {
			this.extended(blocks.slice(1));
		}
	}

	private setUnit(unit: 'mm' | 'in'): void {
		this.image.unit = unit;
		this.unitScale = unit === 'in' ? 25.4 * SCALE : SCALE;
	}

	private defineAperture(head: string): void {
		const m = /^ADD(\d+)([A-Z_$][\w.$-]*)(?:,(.*))?$/i.exec(head);
		if (!m) {
			this.warn(`Unrecognized aperture definition: ${head}`);
			return;
		}
		const id = Number(m[1]);
		const name = m[2];
		const params = m[3] ? m[3].split('X').map(Number) : [];
		const u = this.unitScale;
		const withHole = (outer: Path, holeDiameter: number | undefined): Paths => {
			if (!holeDiameter || holeDiameter <= 0) {
				return [outer];
			}
			return difference([outer], [circle(0, 0, (holeDiameter * u) / 2)]);
		};

		if (name === 'C') {
			const d = (params[0] ?? 0) * u;
			this.apertures.set(id, { shape: d > 0 ? withHole(circle(0, 0, d / 2), params[1]) : [], diameter: d });
		}
		else if (name === 'R') {
			const w = (params[0] ?? 0) * u;
			const h = (params[1] ?? params[0] ?? 0) * u;
			this.apertures.set(id, { shape: w > 0 && h > 0 ? withHole(rect(0, 0, w, h), params[2]) : [] });
		}
		else if (name === 'O') {
			const w = (params[0] ?? 0) * u;
			const h = (params[1] ?? params[0] ?? 0) * u;
			this.apertures.set(id, { shape: w > 0 && h > 0 ? withHole(obround(w, h), params[2]) : [] });
		}
		else if (name === 'P') {
			const d = (params[0] ?? 0) * u;
			const n = Math.max(3, Math.round(params[1] ?? 3));
			const rotation = ((params[2] ?? 0) * Math.PI) / 180;
			const outer: Path = [];
			for (let k = 0; k < n; k++) {
				const a = rotation + (k / n) * TWO_PI;
				outer.push({ X: Math.round((Math.cos(a) * d) / 2), Y: Math.round((Math.sin(a) * d) / 2) });
			}
			this.apertures.set(id, { shape: d > 0 ? withHole(outer, params[3]) : [] });
		}
		else {
			const macro = this.macros.get(name);
			if (!macro) {
				this.warn(`Aperture D${id} uses undefined macro ${name}`);
				this.apertures.set(id, { shape: [] });
				return;
			}
			this.apertures.set(id, { shape: this.evaluateMacro(macro, params) });
		}
	}

	private defineMacro(name: string, body: string[]): void {
		const statements: MacroStatement[] = [];
		for (const raw of body) {
			const line = raw.replace(/\s+/g, '');
			if (!line || /^0(?:\D|$)/.test(raw.trim())) {
				continue; // 0 开头是注释
			}
			const assign = /^\$(\d+)=(.+)$/.exec(line);
			if (assign) {
				statements.push({ kind: 'assign', variable: Number(assign[1]), expr: assign[2] });
				continue;
			}
			const parts = line.split(',');
			statements.push({ kind: 'primitive', code: Number(parts[0]), exprs: parts.slice(1) });
		}
		this.macros.set(name, statements);
	}

	private evaluateMacro(statements: MacroStatement[], params: number[]): Paths {
		const variables = new Map<number, number>();
		params.forEach((value, index) => variables.set(index + 1, value));
		const u = this.unitScale;
		let shape: Paths = [];

		for (const statement of statements) {
			if (statement.kind === 'assign') {
				variables.set(statement.variable, evaluateExpression(statement.expr, variables));
				continue;
			}
			const v = statement.exprs.map(expr => evaluateExpression(expr, variables));
			let exposure = v[0] !== 0;
			let primitive: Paths = [];
			let rotation = 0;

			switch (statement.code) {
				case 1: // 圆：曝光, 直径, 圆心 x, 圆心 y[, 旋转]
					primitive = [circle(v[2] * u, v[3] * u, (v[1] * u) / 2)];
					rotation = v[4] ?? 0;
					break;
				case 2:
				case 20: { // 矢量线：曝光, 线宽, 起点 x, y, 终点 x, y, 旋转
					const [w, sx, sy, ex, ey] = [v[1] * u, v[2] * u, v[3] * u, v[4] * u, v[5] * u];
					const length = Math.hypot(ex - sx, ey - sy);
					if (length > 0 && w > 0) {
						const nx = (-(ey - sy) / length) * (w / 2);
						const ny = ((ex - sx) / length) * (w / 2);
						primitive = [[
							{ X: Math.round(sx - nx), Y: Math.round(sy - ny) },
							{ X: Math.round(ex - nx), Y: Math.round(ey - ny) },
							{ X: Math.round(ex + nx), Y: Math.round(ey + ny) },
							{ X: Math.round(sx + nx), Y: Math.round(sy + ny) },
						]];
					}
					rotation = v[6] ?? 0;
					break;
				}
				case 21: // 中心矩形：曝光, 宽, 高, 中心 x, y, 旋转
					primitive = [rect(v[3] * u, v[4] * u, v[1] * u, v[2] * u)];
					rotation = v[5] ?? 0;
					break;
				case 22: // 左下角矩形（已废弃）：曝光, 宽, 高, 左下 x, y, 旋转
					primitive = [rect((v[3] + v[1] / 2) * u, (v[4] + v[2] / 2) * u, v[1] * u, v[2] * u)];
					rotation = v[5] ?? 0;
					break;
				case 4: { // 轮廓：曝光, 顶点数 n, x0, y0, ... xn, yn, 旋转
					const n = Math.round(v[1]);
					const outline: Path = [];
					for (let k = 0; k < n; k++) {
						outline.push({ X: Math.round(v[2 + k * 2] * u), Y: Math.round(v[3 + k * 2] * u) });
					}
					primitive = union([outline], true);
					rotation = v[2 + (n + 1) * 2] ?? 0;
					break;
				}
				case 5: { // 正多边形：曝光, 顶点数, 中心 x, y, 外接圆直径, 旋转
					const n = Math.max(3, Math.round(v[1]));
					const polygon: Path = [];
					for (let k = 0; k < n; k++) {
						const a = (k / n) * TWO_PI;
						polygon.push({ X: Math.round((v[2] + (Math.cos(a) * v[4]) / 2) * u), Y: Math.round((v[3] + (Math.sin(a) * v[4]) / 2) * u) });
					}
					primitive = [polygon];
					rotation = v[5] ?? 0;
					break;
				}
				case 7: { // 热焊盘：中心 x, y, 外径, 内径, 开口宽度, 旋转（没有曝光参数）
					exposure = true;
					const [cx, cy, outer, inner, gap] = [v[0] * u, v[1] * u, v[2] * u, v[3] * u, v[4] * u];
					const ring = difference([circle(cx, cy, outer / 2)], [circle(cx, cy, inner / 2)]);
					primitive = difference(ring, [rect(cx, cy, outer * 1.1, gap), rect(cx, cy, gap, outer * 1.1)]);
					rotation = v[5] ?? 0;
					break;
				}
				default:
					this.warn(`Unsupported macro primitive ${statement.code} (ignored)`);
					continue;
			}

			if (rotation) {
				primitive = rotatePaths(primitive, (rotation * Math.PI) / 180);
			}
			shape = exposure ? union(shape.concat(primitive)) : difference(shape, primitive);
		}
		return shape;
	}

	private stepRepeat(head: string): void {
		this.flushStroke();
		this.closeRepeat();
		const m = /^SRX(\d+)Y(\d+)I([\d.+-]+)J([\d.+-]+)/.exec(head);
		if (m && (Number(m[1]) > 1 || Number(m[2]) > 1)) {
			this.repeat = {
				nx: Number(m[1]),
				ny: Number(m[2]),
				dx: Number(m[3]) * this.unitScale,
				dy: Number(m[4]) * this.unitScale,
				objectStart: this.image.objects.length,
				trackStart: this.image.tracks.length,
			};
		}
	}

	private closeRepeat(): void {
		const repeat = this.repeat;
		if (!repeat) {
			return;
		}
		this.repeat = undefined;
		const objects = this.image.objects.slice(repeat.objectStart);
		const tracks = this.image.tracks.slice(repeat.trackStart);
		for (let ix = 0; ix < repeat.nx; ix++) {
			for (let iy = 0; iy < repeat.ny; iy++) {
				if (ix === 0 && iy === 0) {
					continue;
				}
				const dx = Math.round(ix * repeat.dx);
				const dy = Math.round(iy * repeat.dy);
				for (const object of objects) {
					this.image.objects.push({ dark: object.dark, paths: translate(object.paths, dx, dy) });
				}
				for (const track of tracks) {
					this.image.tracks.push({ ...track, points: translate([track.points], dx, dy)[0] });
				}
			}
		}
	}

	private block(block: string): void {
		// G04 注释
		if (/^G0*4(?:\D|$)/.test(block)) {
			return;
		}
		if (/^M0*[02]$/.test(block)) {
			this.done = true;
			return;
		}

		let rest = block;
		// 一个数据块里可能带一个或多个 G 代码前缀，如 G01X..Y..D01、G54D10
		for (let m = /^G0*(\d+)/.exec(rest); m; m = /^G0*(\d+)/.exec(rest)) {
			this.gCode(Number(m[1]));
			rest = rest.slice(m[0].length);
		}
		if (!rest) {
			return;
		}

		let x: number | undefined;
		let y: number | undefined;
		let i = 0;
		let j = 0;
		let d: number | undefined;
		const re = /([XYIJD])([+-]?[\d.]+)/g;
		for (let m = re.exec(rest); m; m = re.exec(rest)) {
			switch (m[1]) {
				case 'X':
					x = this.coordinate(m[2]);
					break;
				case 'Y':
					y = this.coordinate(m[2]);
					break;
				case 'I':
					i = this.coordinate(m[2]);
					break;
				case 'J':
					j = this.coordinate(m[2]);
					break;
				default:
					d = Number(m[2]);
			}
		}

		if (d !== undefined && d >= 10) {
			this.flushStroke();
			this.current = this.apertures.get(d);
			if (!this.current) {
				this.warn(`Undefined aperture D${d}`);
			}
			return;
		}
		if (d === undefined) {
			if (x === undefined && y === undefined) {
				return;
			}
			// 省略 D 代码时沿用上一次的操作（已废弃但老文件里常见）
			d = this.lastOperation || 1;
		}
		this.lastOperation = d;

		const targetX = x === undefined ? this.x : this.incremental ? this.x + x : x;
		const targetY = y === undefined ? this.y : this.incremental ? this.y + y : y;
		if (d === 1) {
			this.draw(targetX, targetY, i, j);
		}
		else if (d === 2) {
			this.move();
		}
		else if (d === 3) {
			this.flash(targetX, targetY);
		}
		this.x = targetX;
		this.y = targetY;
	}

	private gCode(code: number): void {
		switch (code) {
			case 1:
			case 2:
			case 3:
				this.interpolation = code;
				break;
			case 36:
				this.flushStroke();
				this.inRegion = true;
				this.contour = [];
				break;
			case 37:
				this.closeContour();
				this.inRegion = false;
				break;
			case 70:
				this.setUnit('in');
				break;
			case 71:
				this.setUnit('mm');
				break;
			case 74:
				this.multiQuadrant = false;
				break;
			case 75:
				this.multiQuadrant = true;
				break;
			case 90:
				this.incremental = false;
				break;
			case 91:
				this.incremental = true;
				break;
			default:
				// G54/G55 等只是前缀，没有几何含义
				break;
		}
	}

	private coordinate(text: string): number {
		if (text.includes('.')) {
			return Number(text) * this.unitScale;
		}
		const negative = text.startsWith('-');
		let digits = text.replace(/^[+-]/, '');
		if (this.format.zero === 'T') {
			digits = digits.padEnd(this.format.integer + this.format.decimal, '0');
		}
		const value = (Number(digits) / 10 ** this.format.decimal) * this.unitScale;
		return negative ? -value : value;
	}

	private point(x: number, y: number): Pt {
		return { X: Math.round(x), Y: Math.round(y) };
	}

	private interpolate(x: number, y: number, i: number, j: number): Path {
		if (this.interpolation === 1) {
			return [this.point(x, y)];
		}
		const clockwise = this.interpolation === 2;
		const center = this.arcCenter(x, y, i, j, clockwise);
		const r0 = Math.hypot(this.x - center.x, this.y - center.y);
		const r1 = Math.hypot(x - center.x, y - center.y);
		if (r0 === 0 && r1 === 0) {
			return [this.point(x, y)];
		}
		const a0 = Math.atan2(this.y - center.y, this.x - center.x);
		let sweepAngle = Math.atan2(y - center.y, x - center.x) - a0;
		const closed = Math.abs(x - this.x) < 0.5 && Math.abs(y - this.y) < 0.5;
		if (closed) {
			// 起点终点重合：多象限模式下是整圆，单象限模式下是零长度
			sweepAngle = this.multiQuadrant ? (clockwise ? -TWO_PI : TWO_PI) : 0;
		}
		else if (clockwise) {
			while (sweepAngle >= 0) sweepAngle -= TWO_PI;
		}
		else {
			while (sweepAngle <= 0) sweepAngle += TWO_PI;
		}

		const radius = Math.max(r0, r1);
		const tolerance = ARC_TOLERANCE * SCALE;
		const step = radius > tolerance ? 2 * Math.acos(1 - tolerance / radius) : Math.PI / 4;
		const segments = Math.max(1, Math.ceil(Math.abs(sweepAngle) / step));
		const points: Path = [];
		for (let k = 1; k < segments; k++) {
			const t = k / segments;
			const a = a0 + sweepAngle * t;
			const r = r0 + (r1 - r0) * t;
			points.push(this.point(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r));
		}
		points.push(this.point(x, y));
		return points;
	}

	private arcCenter(x: number, y: number, i: number, j: number, clockwise: boolean): { x: number; y: number } {
		if (this.multiQuadrant) {
			return { x: this.x + i, y: this.y + j };
		}
		// 单象限模式下 I/J 不带符号，四种组合里选出半径一致且圆弧不超过 90° 的那个
		let best = { x: this.x + i, y: this.y + j };
		let bestError = Infinity;
		for (const sx of [1, -1]) {
			for (const sy of [1, -1]) {
				const cx = this.x + sx * Math.abs(i);
				const cy = this.y + sy * Math.abs(j);
				let angle = Math.atan2(y - cy, x - cx) - Math.atan2(this.y - cy, this.x - cx);
				if (clockwise) {
					angle = -angle;
				}
				while (angle < 0) angle += TWO_PI;
				if (angle > Math.PI / 2 + 1e-6) {
					continue;
				}
				const error = Math.abs(Math.hypot(this.x - cx, this.y - cy) - Math.hypot(x - cx, y - cy));
				if (error < bestError) {
					bestError = error;
					best = { x: cx, y: cy };
				}
			}
		}
		return best;
	}

	private draw(x: number, y: number, i: number, j: number): void {
		const points = this.interpolate(x, y, i, j);
		if (this.inRegion) {
			if (!this.contour.length) {
				this.contour.push(this.point(this.x, this.y));
			}
			this.contour.push(...points);
			return;
		}
		if (!this.stroke.length) {
			this.stroke.push(this.point(this.x, this.y));
		}
		this.stroke.push(...points);
	}

	private move(): void {
		if (this.inRegion) {
			this.closeContour();
		}
		else {
			this.flushStroke();
		}
	}

	private flash(x: number, y: number): void {
		this.flushStroke();
		if (this.inRegion) {
			return;
		}
		const aperture = this.current;
		if (!aperture?.shape.length) {
			return;
		}
		this.image.objects.push({ dark: this.dark, paths: translate(aperture.shape, Math.round(x), Math.round(y)) });
		this.image.flashCount++;
	}

	private closeContour(): void {
		const contour = this.contour;
		this.contour = [];
		if (contour.length < 3) {
			return;
		}
		// 带 cut-in 的轮廓会自相接触，按奇偶规则拆成简单多边形
		const paths = union([contour], true);
		if (paths.length) {
			this.image.objects.push({ dark: this.dark, paths });
			this.image.regionCount++;
		}
	}

	private flushStroke(): void {
		const points = dedupe(this.stroke);
		this.stroke = [];
		if (!points.length) {
			return;
		}
		const aperture = this.current;
		const width = aperture?.diameter ?? 0;
		this.image.tracks.push({ points, width, dark: this.dark });
		if (!aperture) {
			return;
		}
		let paths: Paths;
		if (aperture.diameter !== undefined) {
			paths = strokePolyline(points, aperture.diameter);
		}
		else if (aperture.shape.length) {
			// 非圆形光圈走线很少见，按外轮廓扫掠
			paths = sweep(aperture.shape[0], points);
		}
		else {
			paths = [];
		}
		if (paths.length) {
			this.image.objects.push({ dark: this.dark, paths });
		}
	}

	private finish(): void {
		if (this.inRegion) {
			this.closeContour();
		}
		this.flushStroke();
		this.closeRepeat();
	}
}

function obround(w: number, h: number): Path {
	const r = Math.min(w, h) / 2;
	const half = Math.abs(w - h) / 2;
	const horizontal = w >= h;
	const base = circle(0, 0, r);
	const n = base.length;
	const path: Path = [];
	for (let k = 0; k < n; k++) {
		const a = (k / n) * TWO_PI;
		const cos = Math.cos(a);
		const sin = Math.sin(a);
		// 把圆沿长轴方向劈成两半各自平移
		const shift = horizontal ? (cos >= 0 ? half : -half) : (sin >= 0 ? half : -half);
		path.push({
			X: Math.round(cos * r + (horizontal ? shift : 0)),
			Y: Math.round(sin * r + (horizontal ? 0 : shift)),
		});
	}
	return union([path])[0] ?? path;
}

function rotatePaths(paths: Paths, angle: number): Paths {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return paths.map(path => path.map(p => ({ X: Math.round(p.X * cos - p.Y * sin), Y: Math.round(p.X * sin + p.Y * cos) })));
}

function dedupe(points: Path): Path {
	const result: Path = [];
	for (const p of points) {
		const last = result[result.length - 1];
		if (!last || last.X !== p.X || last.Y !== p.Y) {
			result.push(p);
		}
	}
	return result;
}

// 宏表达式：+ - x(乘) / 括号 一元负号 $n
export function evaluateExpression(expression: string, variables: Map<number, number>): number {
	const text = expression.replace(/\s+/g, '');
	let pos = 0;

	const parseFactor = (): number => {
		const ch = text[pos];
		if (ch === '-') {
			pos++;
			return -parseFactor();
		}
		if (ch === '+') {
			pos++;
			return parseFactor();
		}
		if (ch === '(') {
			pos++;
			const value = parseSum();
			if (text[pos] === ')') {
				pos++;
			}
			return value;
		}
		if (ch === '$') {
			const m = /^\$(\d+)/.exec(text.slice(pos));
			if (!m) {
				pos = text.length;
				return 0;
			}
			pos += m[0].length;
			return variables.get(Number(m[1])) ?? 0;
		}
		const m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(pos));
		if (!m) {
			pos = text.length;
			return 0;
		}
		pos += m[0].length;
		return Number(m[0]);
	};

	const parseProduct = (): number => {
		let value = parseFactor();
		while (pos < text.length) {
			const op = text[pos];
			if (op === 'x' || op === 'X') {
				pos++;
				value *= parseFactor();
			}
			else if (op === '/') {
				pos++;
				value /= parseFactor();
			}
			else {
				break;
			}
		}
		return value;
	};

	function parseSum(): number {
		let value = parseProduct();
		while (pos < text.length) {
			const op = text[pos];
			if (op === '+') {
				pos++;
				value += parseProduct();
			}
			else if (op === '-') {
				pos++;
				value -= parseProduct();
			}
			else {
				break;
			}
		}
		return value;
	}

	return parseSum();
}
