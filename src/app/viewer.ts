// 手写的 WebGL2 小预览器：轨道相机 + 平面着色，不值得为这点东西拉 three.js
import type { Mesh } from '../core';

export interface SceneItem {
	mesh: Mesh;
	color: [number, number, number];
	// 列主序 4x4，不给就是单位阵
	matrix?: Float32Array;
}

export interface Marker {
	position: [number, number, number];
	color: string;
}

type Mat4 = Float32Array;

const VERTEX = `#version 300 es
in vec3 aPos;
uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProj;
out vec3 vViewPos;
void main() {
	vec4 view = uView * uModel * vec4(aPos, 1.0);
	vViewPos = view.xyz;
	gl_Position = uProj * view;
}`;

// 法线直接用屏幕空间导数算，省得每个三角形拆顶点
const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vViewPos;
uniform vec3 uColor;
uniform float uUnlit;
out vec4 outColor;
void main() {
	if (uUnlit > 0.5) {
		outColor = vec4(uColor, 1.0);
		return;
	}
	vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
	if (n.z < 0.0) n = -n;
	float key = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
	float fill = max(dot(n, normalize(vec3(-0.6, -0.2, 0.5))), 0.0);
	vec3 h = normalize(normalize(vec3(0.35, 0.55, 0.75)) + vec3(0.0, 0.0, 1.0));
	float spec = pow(max(dot(n, h), 0.0), 40.0) * 0.18;
	vec3 color = uColor * (0.32 + 0.6 * key + 0.18 * fill) + spec;
	outColor = vec4(pow(color, vec3(1.0 / 1.1)), 1.0);
}`;

function identity(): Mat4 {
	const m = new Float32Array(16);
	m[0] = m[5] = m[10] = m[15] = 1;
	return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
	const out = new Float32Array(16);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) {
				sum += a[k * 4 + r] * b[c * 4 + k];
			}
			out[c * 4 + r] = sum;
		}
	}
	return out;
}

function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
	const f = 1 / Math.tan(fovY / 2);
	const m = new Float32Array(16);
	m[0] = f / aspect;
	m[5] = f;
	m[10] = (far + near) / (near - far);
	m[11] = -1;
	m[14] = (2 * far * near) / (near - far);
	return m;
}

function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
	const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
	const x = normalize(cross(up, z));
	const y = cross(z, x);
	const m = identity();
	m[0] = x[0];
	m[4] = x[1];
	m[8] = x[2];
	m[1] = y[0];
	m[5] = y[1];
	m[9] = y[2];
	m[2] = z[0];
	m[6] = z[1];
	m[10] = z[2];
	m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
	m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
	m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
	return m;
}

function cross(a: number[], b: number[]): number[] {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: number[]): number[] {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}

// 绕 Y 轴翻 180° 再抬高 lift：把打印姿态的钢网扣到板子上
export function flipOnto(lift: number): Mat4 {
	const m = identity();
	m[0] = -1;
	m[10] = -1;
	m[14] = lift;
	return m;
}

interface Drawable {
	vao: WebGLVertexArrayObject;
	count: number;
	color: [number, number, number];
	matrix: Mat4;
	buffers: WebGLBuffer[];
}

export class Viewer {
	private readonly gl: WebGL2RenderingContext;
	private readonly program: WebGLProgram;
	private readonly uniforms: Record<string, WebGLUniformLocation | null> = {};
	private readonly overlay: CanvasRenderingContext2D | null;
	private drawables: Drawable[] = [];
	private grid: { vao: WebGLVertexArrayObject; count: number; buffer: WebGLBuffer } | undefined;
	private markers: Marker[] = [];
	private dirty = true;

	private yaw = -Math.PI / 2 + 0.5;
	private pitch = 0.75;
	private distance = 100;
	private target = [0, 0, 0];
	private radius = 50;
	showGrid = true;
	showMarkers = true;

	constructor(private readonly canvas: HTMLCanvasElement, private readonly overlayCanvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
		if (!gl) {
			throw new Error('webgl2');
		}
		this.gl = gl;
		this.overlay = overlayCanvas.getContext('2d');
		this.program = this.link();
		for (const name of ['uModel', 'uView', 'uProj', 'uColor', 'uUnlit']) {
			this.uniforms[name] = gl.getUniformLocation(this.program, name);
		}
		gl.enable(gl.DEPTH_TEST);
		this.bindInput();
		new ResizeObserver(() => this.invalidate()).observe(canvas);
		const loop = (): void => {
			if (this.dirty) {
				this.dirty = false;
				this.render();
			}
			requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);
	}

	private link(): WebGLProgram {
		const gl = this.gl;
		const program = gl.createProgram()!;
		for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
			const shader = gl.createShader(type)!;
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
			}
			gl.attachShader(program, shader);
		}
		gl.bindAttribLocation(program, 0, 'aPos');
		gl.linkProgram(program);
		return program;
	}

	invalidate(): void {
		this.dirty = true;
	}

	setScene(items: SceneItem[], markers: Marker[], keepCamera: boolean): void {
		const gl = this.gl;
		for (const d of this.drawables) {
			gl.deleteVertexArray(d.vao);
			d.buffers.forEach(b => gl.deleteBuffer(b));
		}
		this.drawables = [];
		let min = [Infinity, Infinity, Infinity];
		let max = [-Infinity, -Infinity, -Infinity];
		for (const item of items) {
			if (!item.mesh.triangles.length) {
				continue;
			}
			const vao = gl.createVertexArray()!;
			gl.bindVertexArray(vao);
			const vbo = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
			gl.bufferData(gl.ARRAY_BUFFER, item.mesh.vertices, gl.STATIC_DRAW);
			gl.enableVertexAttribArray(0);
			gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
			const ibo = gl.createBuffer()!;
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
			gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, item.mesh.triangles, gl.STATIC_DRAW);
			const matrix = item.matrix ?? identity();
			this.drawables.push({ vao, count: item.mesh.triangles.length, color: item.color, matrix, buffers: [vbo, ibo] });

			const v = item.mesh.vertices;
			for (let i = 0; i < v.length; i += 3) {
				const p = [
					matrix[0] * v[i] + matrix[4] * v[i + 1] + matrix[8] * v[i + 2] + matrix[12],
					matrix[1] * v[i] + matrix[5] * v[i + 1] + matrix[9] * v[i + 2] + matrix[13],
					matrix[2] * v[i] + matrix[6] * v[i + 1] + matrix[10] * v[i + 2] + matrix[14],
				];
				min = min.map((m, k) => Math.min(m, p[k]));
				max = max.map((m, k) => Math.max(m, p[k]));
			}
		}
		gl.bindVertexArray(null);
		this.markers = markers;

		if (this.drawables.length) {
			const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
			const changed = Math.abs(radius - this.radius) > this.radius * 0.2;
			this.radius = radius;
			this.buildGrid(Math.max(max[0] - min[0], max[1] - min[1]));
			if (!keepCamera || changed) {
				this.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
				this.distance = radius * 2.6;
			}
		}
		this.invalidate();
	}

	resetCamera(): void {
		this.yaw = -Math.PI / 2 + 0.5;
		this.pitch = 0.75;
		this.distance = this.radius * 2.6;
		this.invalidate();
	}

	// 拉近到某个点，问题列表点击定位用
	focus(position: [number, number, number]): void {
		this.target = [...position];
		this.distance = Math.max(8, this.radius * 0.35);
		this.invalidate();
	}

	setAngles(yaw: number, pitch: number, zoom = 1): void {
		this.yaw = yaw;
		this.pitch = pitch;
		this.distance = this.radius * 2.6 / zoom;
		this.invalidate();
	}

	private buildGrid(span: number): void {
		const gl = this.gl;
		if (this.grid) {
			gl.deleteVertexArray(this.grid.vao);
			gl.deleteBuffer(this.grid.buffer);
		}
		const step = 10;
		const half = Math.ceil((span * 0.75) / step) * step;
		const lines: number[] = [];
		for (let v = -half; v <= half; v += step) {
			lines.push(v, -half, 0, v, half, 0, -half, v, 0, half, v, 0);
		}
		const vao = gl.createVertexArray()!;
		gl.bindVertexArray(vao);
		const buffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);
		this.grid = { vao, count: lines.length / 3, buffer };
	}

	private bindInput(): void {
		const canvas = this.canvas;
		let mode: 'orbit' | 'pan' | undefined;
		let lastX = 0;
		let lastY = 0;
		canvas.addEventListener('contextmenu', e => e.preventDefault());
		canvas.addEventListener('pointerdown', (e) => {
			mode = e.button === 0 && !e.shiftKey ? 'orbit' : 'pan';
			lastX = e.clientX;
			lastY = e.clientY;
			canvas.setPointerCapture(e.pointerId);
		});
		canvas.addEventListener('pointerup', (e) => {
			mode = undefined;
			canvas.releasePointerCapture(e.pointerId);
		});
		canvas.addEventListener('pointermove', (e) => {
			if (!mode) {
				return;
			}
			const dx = e.clientX - lastX;
			const dy = e.clientY - lastY;
			lastX = e.clientX;
			lastY = e.clientY;
			if (mode === 'orbit') {
				this.yaw -= dx * 0.008;
				this.pitch = Math.min(Math.PI / 2 - 0.01, Math.max(-Math.PI / 2 + 0.01, this.pitch + dy * 0.008));
			}
			else {
				const scale = (this.distance / canvas.clientHeight) * 1.1;
				const right = [-Math.sin(this.yaw), Math.cos(this.yaw), 0];
				const up = [-Math.cos(this.yaw) * Math.sin(this.pitch), -Math.sin(this.yaw) * Math.sin(this.pitch), Math.cos(this.pitch)];
				for (let k = 0; k < 3; k++) {
					this.target[k] += (-right[k] * dx + up[k] * dy) * scale;
				}
			}
			this.invalidate();
		});
		canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			this.distance = Math.min(this.radius * 12, Math.max(this.radius * 0.15, this.distance * Math.exp(e.deltaY * 0.0012)));
			this.invalidate();
		}, { passive: false });
	}

	private render(): void {
		const gl = this.gl;
		const canvas = this.canvas;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
		const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
			this.overlayCanvas.width = width;
			this.overlayCanvas.height = height;
		}
		gl.viewport(0, 0, width, height);
		gl.clearColor(0.075, 0.086, 0.106, 1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		const eye = [
			this.target[0] + this.distance * Math.cos(this.pitch) * Math.cos(this.yaw),
			this.target[1] + this.distance * Math.cos(this.pitch) * Math.sin(this.yaw),
			this.target[2] + this.distance * Math.sin(this.pitch),
		];
		const view = lookAt(eye, this.target, [0, 0, 1]);
		const proj = perspective(0.6, width / height, this.distance * 0.02, this.distance * 20 + this.radius * 4);

		gl.useProgram(this.program);
		gl.uniformMatrix4fv(this.uniforms.uView, false, view);
		gl.uniformMatrix4fv(this.uniforms.uProj, false, proj);

		if (this.showGrid && this.grid) {
			gl.uniformMatrix4fv(this.uniforms.uModel, false, identity());
			gl.uniform3f(this.uniforms.uColor, 0.17, 0.2, 0.25);
			gl.uniform1f(this.uniforms.uUnlit, 1);
			gl.bindVertexArray(this.grid.vao);
			gl.drawArrays(gl.LINES, 0, this.grid.count);
		}

		gl.uniform1f(this.uniforms.uUnlit, 0);
		// 网格线和贴床的那面重合，往后推一点免得闪
		gl.enable(gl.POLYGON_OFFSET_FILL);
		gl.polygonOffset(-1, -1);
		for (const d of this.drawables) {
			gl.uniformMatrix4fv(this.uniforms.uModel, false, d.matrix);
			gl.uniform3f(this.uniforms.uColor, d.color[0], d.color[1], d.color[2]);
			gl.bindVertexArray(d.vao);
			gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, 0);
		}
		gl.disable(gl.POLYGON_OFFSET_FILL);
		gl.bindVertexArray(null);

		this.drawMarkers(multiply(proj, view), width, height, dpr);
	}

	private drawMarkers(viewProj: Mat4, width: number, height: number, dpr: number): void {
		const ctx = this.overlay;
		if (!ctx) {
			return;
		}
		ctx.clearRect(0, 0, width, height);
		if (!this.showMarkers) {
			return;
		}
		ctx.lineWidth = 1.2 * dpr;
		for (const marker of this.markers) {
			const [x, y, z] = marker.position;
			const w = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
			if (w <= 0) {
				continue;
			}
			const sx = ((viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12]) / w * 0.5 + 0.5) * width;
			const sy = (0.5 - (viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13]) / w * 0.5) * height;
			ctx.beginPath();
			ctx.arc(sx, sy, 3.5 * dpr, 0, Math.PI * 2);
			ctx.strokeStyle = marker.color;
			ctx.fillStyle = `${marker.color}33`;
			ctx.fill();
			ctx.stroke();
		}
	}
}
