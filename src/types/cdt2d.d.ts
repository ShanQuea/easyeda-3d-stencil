declare module 'cdt2d' {
	interface Cdt2dOptions {
		/** 是否做 Delaunay 优化，默认 true */
		delaunay?: boolean;
		/** 是否保留约束边界内部的三角形，默认 true */
		interior?: boolean;
		/** 是否保留约束边界外部的三角形，默认 true */
		exterior?: boolean;
		infinity?: boolean;
	}
	export default function cdt2d(
		points: Array<[number, number]>,
		edges?: Array<[number, number]>,
		options?: Cdt2dOptions,
	): Array<[number, number, number]>;
}
