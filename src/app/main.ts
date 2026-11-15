import type { BoardData, Mesh, StencilParams, StencilResult } from '../core';
import type { LoadedBoard } from './host';
import type { Key, Lang } from './i18n';
import type { Marker, SceneItem } from './viewer';
import { applyNozzle, buildMesh, DEFAULT_PARAMS, generateStencil, loadBoard, nozzlePreset, to3mf, toStl } from '../core';
import { demoGerbers } from '../core/demo';
import { DOCK_MAX } from '../window';
import { dockWindow, hostLanguage, inEda, readBoardThickness, readFiles, readFromEda, saveFile } from './host';
import { getLang, setLang, t } from './i18n';
import { flipOnto, Viewer } from './viewer';

const STORAGE_KEY = 'easyeda-3d-stencil.params';
const PAD_HEIGHT = 0.035;

const COLORS = {
	stencil: [0.92, 0.93, 0.95] as [number, number, number],
	board: [0.06, 0.36, 0.23] as [number, number, number],
	pad: [0.86, 0.69, 0.32] as [number, number, number],
	narrow: '#ff5d5d',
	web: '#ffb020',
};

type ViewMode = 'print' | 'assembled';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

let params: StencilParams = loadParams();
let board: { name: string; data: BoardData } | undefined;
let result: StencilResult | undefined;
let viewMode: ViewMode = 'print';
let viewer: Viewer | undefined;
let autoThickness: number | undefined;
let pending = 0;

function loadParams(): StencilParams {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
		const merged = { ...DEFAULT_PARAMS };
		// 只认类型对得上的字段，免得旧版本存的东西把界面搞坏
		for (const key of Object.keys(DEFAULT_PARAMS) as Array<keyof StencilParams>) {
			if (typeof saved[key] === typeof DEFAULT_PARAMS[key]) {
				(merged as Record<string, unknown>)[key] = saved[key];
			}
		}
		return merged;
	}
	catch {
		return { ...DEFAULT_PARAMS };
	}
}

function saveParams(): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
	}
	catch {
		// 隐私模式之类的存不了就算了
	}
}

function fmt(value: number, digits = 2): string {
	return String(Math.round(value * 10 ** digits) / 10 ** digits);
}

function toast(message: string, bad = false): void {
	const el = $('#toast');
	el.textContent = message;
	el.classList.toggle('bad', bad);
	el.hidden = false;
	clearTimeout(Number(el.dataset.timer));
	el.dataset.timer = String(setTimeout(() => (el.hidden = true), bad ? 6000 : 2500));
}

function busy(text: string | undefined): void {
	$('#busy').hidden = !text;
	$('#busy-text').textContent = text ?? '';
}

// 把 params 的值刷到界面上
function syncControls(): void {
	for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('input[data-param]'))) {
		const value = params[el.dataset.param as keyof StencilParams];
		if (el.type === 'checkbox') {
			el.checked = Boolean(value);
		}
		else if (document.activeElement !== el) {
			el.value = String(value);
		}
	}
	for (const group of Array.from(document.querySelectorAll<HTMLElement>('.segmented[data-param]'))) {
		const value = String(params[group.dataset.param as keyof StencilParams]);
		for (const button of Array.from(group.querySelectorAll('button'))) {
			button.classList.toggle('on', button.dataset.value === value);
		}
	}
	for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-when]'))) {
		const [key, values] = el.dataset.when!.split('=');
		el.hidden = !values.split(',').includes(String(params[key as keyof StencilParams]));
	}
	$('#frame-width-label').textContent = t(params.frameMode === 'none' ? 'frameWidth.none' : 'frameWidth');

	const preset = nozzlePreset(params.nozzle);
	$('#nozzle-hint').textContent = t('nozzle.hint', preset.layerHeight, preset.lineWidth, preset.minPitch);
	let changed = false;
	for (const key of ['thickness', 'compensation', 'clearance'] as const) {
		const differs = Math.abs(params[key] - preset[key]) > 1e-9;
		changed ||= differs;
		document.querySelector(`input[data-param="${key}"]`)?.parentElement?.classList.toggle('changed', differs);
	}
	$('#nozzle-reset').hidden = !changed;

	const note = $('#thickness-note');
	note.hidden = autoThickness === undefined || params.frameMode === 'none';
	note.textContent = autoThickness === undefined ? '' : t('boardThickness.auto', autoThickness);

	for (const button of Array.from($('#view-mode').querySelectorAll('button'))) {
		button.classList.toggle('on', button.dataset.value === viewMode);
	}
}

function bindControls(): void {
	for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('input[data-param]'))) {
		el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
			const key = el.dataset.param as keyof StencilParams;
			if (el.type === 'checkbox') {
				setParam(key, el.checked);
				return;
			}
			const value = Number(el.value);
			if (el.value === '' || !Number.isFinite(value)) {
				return;
			}
			setParam(key, Math.min(Number(el.max), Math.max(Number(el.min), value)));
		});
		// 输到一半的值不去动它，失焦时再规整
		el.addEventListener('blur', syncControls);
	}
	for (const group of Array.from(document.querySelectorAll<HTMLElement>('.segmented[data-param]'))) {
		group.addEventListener('click', (e) => {
			const value = (e.target as HTMLElement).closest('button')?.dataset.value;
			if (value === undefined) {
				return;
			}
			if (group.dataset.param === 'nozzle') {
				params = applyNozzle(params, Number(value));
				changed();
			}
			else {
				setParam(group.dataset.param as keyof StencilParams, value);
			}
		});
	}
	$('#nozzle-reset').addEventListener('click', () => {
		params = applyNozzle(params, params.nozzle);
		changed();
	});
}

function setParam(key: keyof StencilParams, value: unknown): void {
	params = { ...params, [key]: value };
	changed();
}

function changed(): void {
	saveParams();
	syncControls();
	schedule(true);
}

function schedule(keepCamera: boolean): void {
	const ticket = ++pending;
	if (!board) {
		return;
	}
	busy(t('busy'));
	// 先让「计算中」画出来，顺便给连续输入做个防抖
	setTimeout(() => {
		if (ticket !== pending) {
			return;
		}
		try {
			result = generateStencil(board!.data, params);
		}
		catch (error) {
			result = undefined;
			toast(t('error.failed', String((error as Error).message ?? error)), true);
		}
		busy(undefined);
		refresh(keepCamera);
	}, 120);
}

let preview: { key: string; board: Mesh; pads: Mesh } | undefined;

function refresh(keepCamera: boolean): void {
	$<HTMLButtonElement>('#export-stl').disabled = !result;
	$<HTMLButtonElement>('#export-3mf').disabled = !result;
	$('#drop').classList.toggle('loaded', Boolean(board));
	$('#source-name').textContent = board ? board.name : t('source.none');
	renderStats();
	renderChecks();
	renderScene(keepCamera);
}

function renderScene(keepCamera: boolean): void {
	if (!viewer) {
		return;
	}
	if (!result) {
		viewer.setScene([], [], true);
		return;
	}
	const { model, mesh, analysis } = result;
	const assembled = viewMode === 'assembled';
	const items: SceneItem[] = [];
	const lift = params.boardThickness + params.thickness;

	if (assembled) {
		// 板子和焊盘只跟外形、开孔有关，改别的参数不用重建
		const key = JSON.stringify([params.side, params.boardThickness, params.compensation, params.keepWebs, params.nozzle, board?.name, model.apertures.length]);
		if (preview?.key !== key) {
			preview = {
				key,
				board: buildMesh([{ paths: model.board, height: params.boardThickness }]),
				pads: buildMesh([{ paths: model.apertures, height: PAD_HEIGHT }]),
			};
		}
		items.push({ mesh: preview.board, color: COLORS.board, matrix: flipOnto(params.boardThickness) });
		items.push({ mesh: preview.pads, color: COLORS.pad, matrix: flipOnto(params.boardThickness + PAD_HEIGHT) });
		items.push({ mesh, color: COLORS.stencil, matrix: flipOnto(lift) });
	}
	else {
		items.push({ mesh, color: COLORS.stencil });
	}

	const markers: Marker[] = analysis.issues.map(issue => ({
		position: assembled ? [-issue.x, issue.y, lift] : [issue.x, issue.y, params.thickness],
		color: issue.kind === 'narrowAperture' ? COLORS.narrow : COLORS.web,
	}));
	viewer.showGrid = !assembled;
	viewer.setScene(items, markers, keepCamera);
}

function renderStats(): void {
	const el = $('#stats');
	el.textContent = '';
	if (!result) {
		return;
	}
	const { analysis, mesh } = result;
	const rows: Array<[Key, string]> = [
		['stat.size', `${fmt(analysis.width, 1)} × ${fmt(analysis.depth, 1)} × ${fmt(analysis.height)} mm`],
		['stat.apertures', String(analysis.apertureCount)],
		['stat.paste', `${fmt(analysis.pasteVolume, 1)} mm³`],
		['stat.triangles', (mesh.triangles.length / 3).toLocaleString()],
	];
	for (const [key, value] of rows) {
		const div = document.createElement('div');
		const dt = document.createElement('dt');
		const dd = document.createElement('dd');
		dt.textContent = t(key);
		dd.textContent = value;
		div.append(dt, dd);
		el.append(div);
	}
}

function renderChecks(): void {
	const list = $('#checks');
	list.textContent = '';
	const add = (level: 'ok' | 'warn' | 'bad' | 'info', text: string): void => {
		const li = document.createElement('li');
		li.className = level;
		li.textContent = text;
		list.append(li);
	};
	if (!board || !result) {
		add('info', t('source.none'));
		return;
	}
	const { analysis, model } = result;
	let clean = true;
	if (!analysis.apertureCount) {
		add('bad', t('check.noPaste'));
		clean = false;
	}
	const method = board.data.outlineMethod;
	if (method === 'bbox' || method === 'stroke' || method === 'none') {
		add(method === 'stroke' ? 'warn' : 'bad', t(`check.outline.${method}`));
		clean = false;
	}
	if (model.webFix.count) {
		add('info', t('check.webFix', model.webFix.count, params.nozzle));
	}
	if (analysis.narrowApertures) {
		add('bad', t('check.narrow', analysis.narrowApertures, fmt(analysis.minOpening), params.nozzle));
		clean = false;
	}
	if (analysis.thinWebs) {
		add('warn', t('check.web', analysis.thinWebs, fmt(analysis.minWeb)));
		clean = false;
	}
	if (params.frameMode !== 'none' && model.frameHeight < 0.4) {
		add('warn', t('check.frameLow', fmt(model.frameHeight)));
		clean = false;
	}
	for (const warning of board.data.warnings.slice(0, 3)) {
		add('warn', t('check.gerber', warning));
	}
	if (clean) {
		add('ok', t('check.ok'));
	}
}

function useBoard(loaded: LoadedBoard): void {
	board = { name: loaded.name, data: loadBoard(loaded.sources) };
	preview = undefined;
	if (!board.data.paste[params.side].length && board.data.paste[params.side === 'top' ? 'bottom' : 'top'].length) {
		// 这一面没东西而另一面有，直接切过去
		params = { ...params, side: params.side === 'top' ? 'bottom' : 'top' };
		syncControls();
	}
	schedule(false);
}

async function loadFromEda(): Promise<void> {
	busy(t('busy.eda'));
	try {
		const loaded = await readFromEda();
		if (!loaded) {
			busy(undefined);
			toast(t('error.noGerber'), true);
			return;
		}
		autoThickness = await readBoardThickness();
		if (autoThickness !== undefined) {
			params = { ...params, boardThickness: autoThickness };
			saveParams();
		}
		syncControls();
		useBoard(loaded);
	}
	catch (error) {
		busy(undefined);
		toast(`${t('error.noGerber')} ${String((error as Error).message ?? '')}`, true);
	}
}

async function loadFiles(files: File[]): Promise<void> {
	if (!files.length) {
		return;
	}
	try {
		const loaded = await readFiles(files);
		if (!loaded) {
			toast(t('error.noLayers'), true);
			return;
		}
		autoThickness = undefined;
		syncControls();
		useBoard(loaded);
	}
	catch (error) {
		toast(t('error.failed', String((error as Error).message ?? error)), true);
	}
}

function loadDemo(): void {
	autoThickness = undefined;
	useBoard({ name: t('source.demoName'), sources: demoGerbers() });
}

async function exportAs(format: 'stl' | '3mf'): Promise<void> {
	if (!result || !board) {
		return;
	}
	const base = board.name.replace(/[\\/:*?"<>|\s]+/g, '_');
	const fileName = `${base}_stencil_${params.side}_${fmt(params.thickness)}mm.${format}`;
	const data = format === 'stl' ? toStl(result.mesh, fileName) : await to3mf(result.mesh, fileName);
	await saveFile(data, fileName, format === 'stl' ? 'model/stl' : 'model/3mf');
	toast(t('export.done', fileName));
}

function bindStage(): void {
	$('#view-mode').addEventListener('click', (e) => {
		const value = (e.target as HTMLElement).closest('button')?.dataset.value as ViewMode | undefined;
		if (value && value !== viewMode) {
			viewMode = value;
			syncControls();
			renderScene(false);
		}
	});
	$('#view-reset').addEventListener('click', () => viewer?.resetCamera());
	$('#view-top').addEventListener('click', () => {
		if (viewMode !== 'assembled') {
			viewMode = 'assembled';
			syncControls();
			renderScene(false);
		}
		viewer?.setAngles(-Math.PI / 2, Math.PI / 2 - 0.001);
	});
	$('#view-issues').addEventListener('click', (e) => {
		if (viewer) {
			viewer.showMarkers = !viewer.showMarkers;
			(e.currentTarget as HTMLElement).classList.toggle('on', viewer.showMarkers);
			viewer.invalidate();
		}
	});

	const drop = $('#drop');
	let depth = 0;
	window.addEventListener('dragenter', (e) => {
		e.preventDefault();
		depth++;
		drop.classList.add('over');
	});
	window.addEventListener('dragleave', () => {
		if (--depth <= 0) {
			depth = 0;
			drop.classList.remove('over');
		}
	});
	window.addEventListener('dragover', e => e.preventDefault());
	window.addEventListener('drop', (e) => {
		e.preventDefault();
		depth = 0;
		drop.classList.remove('over');
		void loadFiles(Array.from(e.dataTransfer?.files ?? []));
	});

	const input = $<HTMLInputElement>('#file-input');
	$('#load-file').addEventListener('click', () => input.click());
	input.addEventListener('change', () => {
		void loadFiles(Array.from(input.files ?? []));
		input.value = '';
	});
	$('#load-demo').addEventListener('click', loadDemo);
	$('#load-eda').addEventListener('click', () => void loadFromEda());
	$('#export-stl').addEventListener('click', () => void exportAs('stl'));
	$('#export-3mf').addEventListener('click', () => void exportAs('3mf'));
	$('#lang').addEventListener('click', () => applyLang(getLang() === 'zh' ? 'en' : 'zh'));
}

function applyLang(lang: Lang): void {
	setLang(lang);
	$('#lang').textContent = lang === 'zh' ? 'EN' : '中文';
	syncControls();
	if (board) {
		refresh(true);
	}
	else {
		renderChecks();
		$('#source-name').textContent = t('source.none');
	}
}

async function main(): Promise<void> {
	const query = new URLSearchParams(location.search);
	const lang = query.get('lang');
	applyLang(lang === 'en' || lang === 'zh' ? lang : await hostLanguage());

	try {
		viewer = new Viewer($<HTMLCanvasElement>('#gl'), $<HTMLCanvasElement>('#overlay'));
	}
	catch {
		toast(t('error.webgl'), true);
	}
	bindControls();
	bindStage();
	syncControls();

	// 链接里可以带参数，方便分享某个状态：?nozzle=0.2&frame=corners&side=bottom&view=assembled
	const nozzle = Number(query.get('nozzle'));
	if (nozzle > 0) {
		params = applyNozzle(params, nozzle);
	}
	const frame = query.get('frame');
	if (frame === 'full' || frame === 'corners' || frame === 'none') {
		params = { ...params, frameMode: frame };
	}
	const side = query.get('side');
	if (side === 'top' || side === 'bottom') {
		params = { ...params, side };
	}
	if (query.get('view') === 'assembled') {
		viewMode = 'assembled';
	}
	syncControls();
	if (inEda) {
		// 入口没拿到视口大小时开的是默认窗口，这里挪到右边，新窗口会重新加载
		if (window.innerWidth > DOCK_MAX && await dockWindow(t('title'))) {
			return;
		}
		$('#load-eda').hidden = false;
		$('#load-demo').hidden = true;
		await loadFromEda();
	}
	else {
		// 单独打开网页时先放个示例，不至于一片空白
		loadDemo();
	}
	// 截图脚本用
	(window as unknown as Record<string, unknown>).__stencil = { viewer: () => viewer };
}

void main();
