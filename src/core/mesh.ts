// 所有区域的边界一起做一次约束 Delaunay，再按三角形所在区域给高度、补侧壁。
// 全程共用一套顶点，所以出来的网格不会有 T 形缝
import type { Paths } from './geom';
import cdt2d from 'cdt2d';
import { pointInPaths, SCALE } from './geom';

export interface HeightRegion {
	paths: Paths;
	height: number;
}

export interface Mesh {
	vertices: Float32Array;
	triangles: Uint32Array;
}

const WELD = 2;
const ON_EDGE = 2;
const CELL = 1000;

interface Planar {
	points: Array<[number, number]>;
	edges: Array<[number, number]>;
}

export function buildMesh(regions: HeightRegion[]): Mesh {
	const solid = regions.filter(r => r.height > 0 && r.paths.length);
	const planar = conformingEdges(solid.map(r => r.paths));
	if (planar.points.length < 3) {
		return { vertices: new Float32Array(0), triangles: new Uint32Array(0) };
	}

	const cells = cdt2d(planar.points, planar.edges, { delaunay: true, interior: true, exterior: true });
	const { points } = planar;
	const triCount = cells.length;

	for (const cell of cells) {
		const [a, b, c] = cell;
		const cross = (points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) - (points[b][1] - points[a][1]) * (points[c][0] - points[a][0]);
		if (cross < 0) {
			cell[1] = c;
			cell[2] = b;
		}
	}

	const pointCount = points.length;
	const edgeKey = (a: number, b: number): number => (a < b ? a * pointCount + b : b * pointCount + a);
	const constrained = new Set<number>();
	for (const [a, b] of planar.edges) {
		constrained.add(edgeKey(a, b));
	}

	const edgeTriangles = new Map<number, number[]>();
	for (let t = 0; t < triCount; t++) {
		const cell = cells[t];
		for (let k = 0; k < 3; k++) {
			const key = edgeKey(cell[k], cell[(k + 1) % 3]);
			const list = edgeTriangles.get(key);
			if (list) {
				list.push(t);
			}
			else {
				edgeTriangles.set(key, [t]);
			}
		}
	}

	// 沿非约束边做洪水填充，同一连通块一定属于同一区域，每块只需要做一次点在多边形内判断
	const heights = new Float64Array(triCount);
	const visited = new Uint8Array(triCount);
	const sorted = solid.slice().sort((a, b) => b.height - a.height);
	const triArea = (t: number): number => {
		const [a, b, c] = cells[t];
		return Math.abs((points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) - (points[b][1] - points[a][1]) * (points[c][0] - points[a][0]));
	};
	for (let seed = 0; seed < triCount; seed++) {
		if (visited[seed]) {
			continue;
		}
		const component: number[] = [seed];
		visited[seed] = 1;
		let best = seed;
		let bestArea = triArea(seed);
		for (let head = 0; head < component.length; head++) {
			const t = component[head];
			const cell = cells[t];
			for (let k = 0; k < 3; k++) {
				const key = edgeKey(cell[k], cell[(k + 1) % 3]);
				if (constrained.has(key)) {
					continue;
				}
				for (const other of edgeTriangles.get(key)!) {
					if (!visited[other]) {
						visited[other] = 1;
						component.push(other);
						const a = triArea(other);
						if (a > bestArea) {
							bestArea = a;
							best = other;
						}
					}
				}
			}
		}
		// 用块里最大的三角形的重心做代表点，离边界最远、最不容易误判
		const [a, b, c] = cells[best];
		const cx = (points[a][0] + points[b][0] + points[c][0]) / 3;
		const cy = (points[a][1] + points[b][1] + points[c][1]) / 3;
		let height = 0;
		for (const region of sorted) {
			if (pointInPaths(cx, cy, region.paths)) {
				height = region.height;
				break;
			}
		}
		if (height > 0) {
			for (const t of component) {
				heights[t] = height;
			}
		}
	}

	// 所有出现过的高度层（含 0），侧壁要在每一层都分段
	const levels = Array.from(new Set([0, ...solid.map(r => r.height)])).sort((a, b) => a - b);
	const levelIndex = new Map(levels.map((z, i) => [z, i]));
	const levelCount = levels.length;

	const vertexIds = new Map<number, number>();
	const vertices: number[] = [];
	const triangles: number[] = [];
	const vertex = (point: number, level: number): number => {
		const key = point * levelCount + level;
		let id = vertexIds.get(key);
		if (id === undefined) {
			id = vertices.length / 3;
			vertices.push(points[point][0] / SCALE, points[point][1] / SCALE, levels[level]);
			vertexIds.set(key, id);
		}
		return id;
	};

	for (let t = 0; t < triCount; t++) {
		const h = heights[t];
		if (h <= 0) {
			continue;
		}
		const cell = cells[t];
		const top = levelIndex.get(h)!;
		triangles.push(vertex(cell[0], top), vertex(cell[1], top), vertex(cell[2], top));
		triangles.push(vertex(cell[0], 0), vertex(cell[2], 0), vertex(cell[1], 0));

		for (let k = 0; k < 3; k++) {
			const a = cell[k];
			const b = cell[(k + 1) % 3];
			const pair = edgeTriangles.get(edgeKey(a, b))!;
			const neighbour = pair.length > 1 ? (pair[0] === t ? pair[1] : pair[0]) : -1;
			const hn = neighbour < 0 ? 0 : heights[neighbour];
			if (hn >= h) {
				continue; // 侧壁由高的一侧负责生成
			}
			for (let level = levelIndex.get(hn)!; level < top; level++) {
				const a0 = vertex(a, level);
				const b0 = vertex(b, level);
				const a1 = vertex(a, level + 1);
				const b1 = vertex(b, level + 1);
				triangles.push(a0, b0, b1, a0, b1, a1);
			}
		}
	}

	return { vertices: new Float32Array(vertices), triangles: new Uint32Array(triangles) };
}

// 焊点、把落在别人边上的顶点处打断、去重，不然 cdt2d 会出 T 形缝
function conformingEdges(groups: Paths[]): Planar {
	const points: Array<[number, number]> = [];
	const fine = new Map<string, number[]>();

	const pointId = (x: number, y: number): number => {
		const gx = Math.floor(x / (WELD * 2));
		const gy = Math.floor(y / (WELD * 2));
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (const id of fine.get(`${gx + dx},${gy + dy}`) ?? []) {
					if (Math.abs(points[id][0] - x) <= WELD && Math.abs(points[id][1] - y) <= WELD) {
						return id;
					}
				}
			}
		}
		const id = points.length;
		points.push([x, y]);
		const key = `${gx},${gy}`;
		const bucket = fine.get(key);
		if (bucket) {
			bucket.push(id);
		}
		else {
			fine.set(key, [id]);
		}
		return id;
	};

	let edges: Array<[number, number]> = [];
	for (const paths of groups) {
		for (const path of paths) {
			const ids = path.map(p => pointId(p.X, p.Y));
			for (let i = 0; i < ids.length; i++) {
				const a = ids[i];
				const b = ids[(i + 1) % ids.length];
				if (a !== b) {
					edges.push([a, b]);
				}
			}
		}
	}

	const coarse = new Map<string, number[]>();
	points.forEach(([x, y], id) => {
		const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
		const bucket = coarse.get(key);
		if (bucket) {
			bucket.push(id);
		}
		else {
			coarse.set(key, [id]);
		}
	});

	const split: Array<[number, number]> = [];
	for (const [a, b] of edges) {
		const [ax, ay] = points[a];
		const [bx, by] = points[b];
		const dx = bx - ax;
		const dy = by - ay;
		const lengthSq = dx * dx + dy * dy;
		const hits: Array<{ t: number; id: number }> = [];
		const x0 = Math.floor((Math.min(ax, bx) - ON_EDGE) / CELL);
		const x1 = Math.floor((Math.max(ax, bx) + ON_EDGE) / CELL);
		const y0 = Math.floor((Math.min(ay, by) - ON_EDGE) / CELL);
		const y1 = Math.floor((Math.max(ay, by) + ON_EDGE) / CELL);
		for (let gx = x0; gx <= x1; gx++) {
			for (let gy = y0; gy <= y1; gy++) {
				const bucket = coarse.get(`${gx},${gy}`);
				if (!bucket) {
					continue;
				}
				for (const id of bucket) {
					if (id === a || id === b) {
						continue;
					}
					const px = points[id][0] - ax;
					const py = points[id][1] - ay;
					const t = (px * dx + py * dy) / lengthSq;
					if (t <= 0 || t >= 1) {
						continue;
					}
					const distance = Math.abs(px * dy - py * dx) / Math.sqrt(lengthSq);
					if (distance <= ON_EDGE) {
						hits.push({ t, id });
					}
				}
			}
		}
		if (!hits.length) {
			split.push([a, b]);
			continue;
		}
		hits.sort((p, q) => p.t - q.t);
		let previous = a;
		for (const hit of hits) {
			split.push([previous, hit.id]);
			previous = hit.id;
		}
		split.push([previous, b]);
	}

	const seen = new Set<number>();
	const count = points.length;
	edges = [];
	for (const [a, b] of split) {
		if (a === b) {
			continue;
		}
		const key = a < b ? a * count + b : b * count + a;
		if (!seen.has(key)) {
			seen.add(key);
			edges.push([a, b]);
		}
	}
	return { points, edges };
}

export interface MeshReport {
	triangleCount: number;
	vertexCount: number;
	// 没有恰好被两个三角形（方向相反）共享的边数，0 才是水密流形
	badEdges: number;
	volume: number;
}

export function inspectMesh(mesh: Mesh): MeshReport {
	const { vertices, triangles } = mesh;
	const vertexCount = vertices.length / 3;
	const balance = new Map<number, number>();
	const uses = new Map<number, number>();
	let volume = 0;
	for (let i = 0; i < triangles.length; i += 3) {
		const ids = [triangles[i], triangles[i + 1], triangles[i + 2]];
		for (let k = 0; k < 3; k++) {
			const a = ids[k];
			const b = ids[(k + 1) % 3];
			const key = a < b ? a * vertexCount + b : b * vertexCount + a;
			balance.set(key, (balance.get(key) ?? 0) + (a < b ? 1 : -1));
			uses.set(key, (uses.get(key) ?? 0) + 1);
		}
		const [a, b, c] = ids.map(id => id * 3);
		volume += (
			vertices[a] * (vertices[b + 1] * vertices[c + 2] - vertices[b + 2] * vertices[c + 1])
			- vertices[a + 1] * (vertices[b] * vertices[c + 2] - vertices[b + 2] * vertices[c])
			+ vertices[a + 2] * (vertices[b] * vertices[c + 1] - vertices[b + 1] * vertices[c])
		) / 6;
	}
	let badEdges = 0;
	for (const [key, count] of uses) {
		// 允许 4 次（两块实体只在一条竖边上相碰），但正反方向必须成对
		if (count % 2 !== 0 || balance.get(key) !== 0) {
			badEdges++;
		}
	}
	return { triangleCount: triangles.length / 3, vertexCount, badEdges, volume };
}
