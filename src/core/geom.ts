// 坐标全用整数，1 单位 = 1µm，clipper 的布尔运算才是精确的
import ClipperLib from 'clipper-lib';

export type Pt = ClipperLib.IntPoint;
export type Path = Pt[];
export type Paths = Path[];

export const SCALE = 1000;
export const ARC_TOLERANCE = 0.005;

export interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export type JoinKind = 'round' | 'miter' | 'square';

const { ClipType, PolyType, PolyFillType, JoinType, EndType } = ClipperLib;

export function toUnits(mm: number): number {
	return Math.round(mm * SCALE);
}

export function toMm(units: number): number {
	return units / SCALE;
}

function run(clipType: ClipperLib.ClipType, subject: Paths, clip: Paths | undefined, fill: ClipperLib.PolyFillType): Paths {
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(subject, PolyType.ptSubject, true);
	if (clip?.length) {
		clipper.AddPaths(clip, PolyType.ptClip, true);
	}
	const solution: Paths = [];
	clipper.Execute(clipType, solution, fill, fill);
	return solution;
}

export function union(paths: Paths, evenOdd = false): Paths {
	if (!paths.length) {
		return [];
	}
	return run(ClipType.ctUnion, paths, undefined, evenOdd ? PolyFillType.pftEvenOdd : PolyFillType.pftNonZero);
}

export function difference(subject: Paths, clip: Paths): Paths {
	if (!subject.length) {
		return [];
	}
	return run(ClipType.ctDifference, subject, clip, PolyFillType.pftNonZero);
}

export function intersection(subject: Paths, clip: Paths): Paths {
	if (!subject.length || !clip.length) {
		return [];
	}
	return run(ClipType.ctIntersection, subject, clip, PolyFillType.pftNonZero);
}

function joinType(join: JoinKind): ClipperLib.JoinType {
	return join === 'round' ? JoinType.jtRound : join === 'miter' ? JoinType.jtMiter : JoinType.jtSquare;
}

export function offset(paths: Paths, deltaMm: number, join: JoinKind = 'round'): Paths {
	if (!paths.length) {
		return [];
	}
	if (deltaMm === 0) {
		return union(paths);
	}
	const co = new ClipperLib.ClipperOffset(3, ARC_TOLERANCE * SCALE);
	co.AddPaths(paths, joinType(join), EndType.etClosedPolygon);
	const solution: Paths = [];
	co.Execute(solution, deltaMm * SCALE);
	return solution;
}

export function strokePolyline(points: Path, width: number): Paths {
	if (width <= 0 || !points.length) {
		return [];
	}
	if (points.length === 1 || points.every(p => p.X === points[0].X && p.Y === points[0].Y)) {
		return [circle(points[0].X, points[0].Y, width / 2)];
	}
	const co = new ClipperLib.ClipperOffset(3, ARC_TOLERANCE * SCALE);
	co.AddPath(points, JoinType.jtRound, EndType.etOpenRound);
	const solution: Paths = [];
	co.Execute(solution, width / 2);
	return solution;
}

export function sweep(pattern: Path, points: Path): Paths {
	if (points.length < 2) {
		return [translatePath(pattern, points[0].X, points[0].Y)];
	}
	return union(ClipperLib.Clipper.MinkowskiSum(pattern, points, false));
}

export function circleSegments(radius: number): number {
	const tol = ARC_TOLERANCE * SCALE;
	if (radius <= tol) {
		return 8;
	}
	const n = Math.ceil(Math.PI / Math.acos(1 - tol / radius));
	return Math.min(180, Math.max(12, n));
}

export function circle(cx: number, cy: number, radius: number, segments = circleSegments(radius)): Path {
	const path: Path = [];
	for (let i = 0; i < segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		path.push({ X: Math.round(cx + Math.cos(a) * radius), Y: Math.round(cy + Math.sin(a) * radius) });
	}
	return path;
}

export function rect(cx: number, cy: number, w: number, h: number): Path {
	const hw = w / 2;
	const hh = h / 2;
	return [
		{ X: Math.round(cx - hw), Y: Math.round(cy - hh) },
		{ X: Math.round(cx + hw), Y: Math.round(cy - hh) },
		{ X: Math.round(cx + hw), Y: Math.round(cy + hh) },
		{ X: Math.round(cx - hw), Y: Math.round(cy + hh) },
	];
}

export function translatePath(path: Path, dx: number, dy: number): Path {
	return path.map(p => ({ X: p.X + dx, Y: p.Y + dy }));
}

export function translate(paths: Paths, dx: number, dy: number): Paths {
	return paths.map(p => translatePath(p, dx, dy));
}

// 沿 Y 轴镜像（x → -x），同时反转点序以保持绕向
export function mirrorX(paths: Paths): Paths {
	return paths.map(path => path.map(p => ({ X: -p.X, Y: p.Y })).reverse());
}

export function area(paths: Paths): number {
	let sum = 0;
	for (const path of paths) {
		sum += ClipperLib.Clipper.Area(path);
	}
	return sum / (SCALE * SCALE);
}

export function pathArea(path: Path): number {
	return ClipperLib.Clipper.Area(path) / (SCALE * SCALE);
}

export function bounds(paths: Paths): Bounds | undefined {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const path of paths) {
		for (const p of path) {
			if (p.X < minX)
				minX = p.X;
			if (p.X > maxX)
				maxX = p.X;
			if (p.Y < minY)
				minY = p.Y;
			if (p.Y > maxY)
				maxY = p.Y;
		}
	}
	return minX === Infinity ? undefined : { minX, minY, maxX, maxY };
}

export function clean(paths: Paths, toleranceMm = 0.002): Paths {
	return ClipperLib.Clipper.CleanPolygons(paths, toleranceMm * SCALE).filter(p => p.length >= 3);
}

export interface Island {
	outer: Path;
	holes: Paths;
}

export function islands(paths: Paths, evenOdd = false): Island[] {
	if (!paths.length) {
		return [];
	}
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(paths, PolyType.ptSubject, true);
	const tree = new ClipperLib.PolyTree();
	const fill = evenOdd ? PolyFillType.pftEvenOdd : PolyFillType.pftNonZero;
	clipper.Execute(ClipType.ctUnion, tree, fill, fill);
	const result: Island[] = [];
	const visit = (node: ClipperLib.PolyNode): void => {
		for (const child of node.Childs()) {
			// 第一层是外轮廓，它的子节点是孔，孔的子节点又是新的岛
			const island: Island = { outer: child.Contour(), holes: [] };
			for (const hole of child.Childs()) {
				island.holes.push(hole.Contour());
				visit(hole);
			}
			result.push(island);
		}
	};
	visit(tree);
	return result;
}

// 奇偶规则的点在多边形内判断（落在边上视为在内）
export function pointInPaths(x: number, y: number, paths: Paths): boolean {
	let inside = false;
	for (const path of paths) {
		const n = path.length;
		for (let i = 0, j = n - 1; i < n; j = i++) {
			const a = path[i];
			const b = path[j];
			if ((a.Y > y) !== (b.Y > y) && x < ((b.X - a.X) * (y - a.Y)) / (b.Y - a.Y) + a.X) {
				inside = !inside;
			}
		}
	}
	return inside;
}
