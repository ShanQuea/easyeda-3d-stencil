import type { BoardData, Mesh, StencilParams, StencilResult } from '../core';
import type { LoadedBoard } from './host';
import type { Key, Lang } from './i18n';
import type { Marker, SceneItem } from './viewer';
import { applyNozzle, buildMesh, DEFAULT_PARAMS, generateStencil, loadBoard, NOZZLE_PRESETS, NOZZLE_RANGE, nozzlePreset, to3mf, toStl } from '../core';
import { demoGerbers } from '../core/demo';
import { DOCK_MAX } from '../window';
import { dockWindow, hostLanguage, inEda, readBoardThickness, readFiles, readFromEda, saveFile } from './host';
import { getLang, setLang, t } from './i18n';
import { flipOnto, Viewer } from './viewer';

const STORAGE_KEY = 'easyeda-3d-stencil.params';
const GROUPS_KEY = 'easyeda-3d-stencil.groups';
// PLA 密度（g/mm³），估用料
const PLA_DENSITY = 1.24e-3;
const PAD_HEIGHT = 0.035;

const COLORS = {
	stencil: [0.92, 0.93, 0.95] as [number, number, number],
	board: [0.06, 0.36, 0.23] as [number, number, number],
	pad: [0.86, 0.69, 0.32] as [number, number, number],
	narrow: '#ff5d5d',
	web: '#ffb020',
	strip: '#3ecf8e',
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
// 点了「自定义」还没输数值时也要显示输入框
let customNozzle = false;
// 问题列表每类点到第几处了
const focusIndex = new Map<string, number>();

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
			el.value = String(Math.round(Number(value) * scaleOf(el) * 1000) / 1000);
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

	const isPreset = NOZZLE_PRESETS.some(p => Math.abs(p.nozzle - params.nozzle) < 1e-6);
	const custom = customNozzle || !isPreset;
	for (const button of Array.from($('#nozzle-pick').querySelectorAll('button'))) {
		const value = button.dataset.value!;
		button.classList.toggle('on', value === 'custom' ? custom : !custom && Number(value) === params.nozzle);
	}
	$('#nozzle-custom').hidden = !custom;
	const nozzleInput = $<HTMLInputElement>('#nozzle-input');
	if (document.activeElement !== nozzleInput) {
		nozzleInput.value = String(params.nozzle);
	}

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
			setParam(key, Math.min(Number(el.max), Math.max(Number(el.min), value)) / scaleOf(el));
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
			setParam(group.dataset.param as keyof StencilParams, value);
		});
	}
	$('#nozzle-pick').addEventListener('click', (e) => {
		const value = (e.target as HTMLElement).closest('button')?.dataset.value;
		if (value === 'custom') {
			customNozzle = true;
			syncControls();
			$<HTMLInputElement>('#nozzle-input').focus();
		}
		else if (value) {
			customNozzle = false;
			params = applyNozzle(params, Number(value));
			changed();
		}
	});
	// 喷嘴一改会连带厚度、补偿一起换，等输完再算
	const nozzleInput = $<HTMLInputElement>('#nozzle-input');
	nozzleInput.addEventListener('change', () => {
		const value = Number(nozzleInput.value);
		if (nozzleInput.value !== '' && Number.isFinite(value)) {
			params = applyNozzle(params, Math.min(NOZZLE_RANGE.max, Math.max(NOZZLE_RANGE.min, value)));
			changed();
		}
	});
	nozzleInput.addEventListener('blur', syncControls);

	const open = loadGroups();
	for (const details of Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-group]'))) {
		const key = details.dataset.group!;
		if (key in open) {
			details.open = open[key];
		}
		details.addEventListener('toggle', () => {
			open[key] = details.open;
			try {
				localStorage.setItem(GROUPS_KEY, JSON.stringify(open));
			}
			catch {
				// 存不了就算了
			}
		});
	}

	$('#nozzle-reset').addEventListener('click', () => {
		params = applyNozzle(params, params.nozzle);
		changed();
	});
}

function scaleOf(el: HTMLElement): number {
	return Number(el.dataset.scale ?? 1);
}

function loadGroups(): Record<string, boolean> {
	try {
		return JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}') as Record<string, boolean>;
	}
	catch {
		return {};
	}
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
		const key = JSON.stringify([params.side, params.boardThickness, params.compensation, params.keepWebs, params.mergeRows, params.stripPaste, params.nozzle, board?.name, model.apertures.length]);
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

	const markers: Marker[] = [
		...analysis.issues.map(issue => ({ position: place(issue), color: issue.kind === 'narrowAperture' ? COLORS.narrow : COLORS.web })),
		...(params.mergeRows ? model.strips.map(strip => ({ position: place(strip), color: COLORS.strip })) : []),
	];
	viewer.showGrid = !assembled;
	viewer.setScene(items, markers, keepCamera);
}

// 问题点在当前视图里的位置：装配预览是翻过来扣在板上的
function place(point: { x: number; y: number }): [number, number, number] {
	return viewMode === 'assembled' ? [-point.x, point.y, params.boardThickness + params.thickness] : [point.x, point.y, params.thickness];
}

function focusNext(key: string, points: Array<{ x: number; y: number }>): void {
	if (!viewer || !points.length) {
		return;
	}
	const i = ((focusIndex.get(key) ?? -1) + 1) % points.length;
	focusIndex.set(key, i);
	viewer.showMarkers = true;
	$('#view-issues').classList.add('on');
	viewer.focus(place(points[i]));
}

function renderStats(): void {
	const el = $('#stats');
	el.textContent = '';
	if (!result) {
		return;
	}
	const { analysis } = result;
	const rows: Array<[Key, string]> = [
		['stat.size', `${fmt(analysis.width, 1)} × ${fmt(analysis.depth, 1)} × ${fmt(analysis.height)} mm`],
		['stat.apertures', String(analysis.apertureCount)],
		['stat.paste', `${fmt(analysis.pasteVolume, 1)} mm³`],
		['stat.filament', t('stat.filament.value', fmt(analysis.volume * PLA_DENSITY, 1))],
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

interface CheckItem {
	level: 'ok' | 'warn' | 'bad' | 'info';
	text: string;
	note?: string;
	points?: Array<{ x: number; y: number }>;
	action?: { label: string; run: () => void };
}

function renderChecks(): void {
	const list = $('#checks');
	list.textContent = '';
	const items: CheckItem[] = [];
	if (!board || !result) {
		items.push({ level: 'info', text: t('source.none') });
	}
	else {
		items.push(...collectChecks(board.data, result));
	}
	for (const [index, item] of items.entries()) {
		const li = document.createElement('li');
		li.className = item.level;
		const text = document.createElement('span');
		text.textContent = item.text;
		li.append(text);
		if (item.note) {
			const note = document.createElement('small');
			note.textContent = item.note;
			li.append(note);
		}
		if (item.points?.length) {
			li.classList.add('locate');
			li.title = t('check.focus');
			li.addEventListener('click', () => focusNext(String(index), item.points!));
		}
		if (item.action) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'primary small';
			button.textContent = item.action.label;
			button.addEventListener('click', (e) => {
				e.stopPropagation();
				item.action!.run();
			});
			li.append(button);
		}
		list.append(li);
	}
}

function collectChecks(data: BoardData, { analysis, model }: StencilResult): CheckItem[] {
	const items: CheckItem[] = [];
	const issues = (kind: string) => analysis.issues.filter(i => i.kind === kind);
	if (!analysis.apertureCount) {
		items.push({ level: 'bad', text: t('check.noPaste') });
	}
	const method = data.outlineMethod;
	if (method === 'bbox' || method === 'stroke' || method === 'none') {
		items.push({ level: method === 'stroke' ? 'warn' : 'bad', text: t(`check.outline.${method}`) });
	}
	if (model.strips.length && !params.mergeRows) {
		const pitch = Math.min(...model.strips.map(s => s.pitch));
		items.push({
			level: 'warn',
			text: t('check.strips', model.strips.length, fmt(pitch), params.nozzle),
			points: model.strips,
			action: { label: t('check.strips.action'), run: () => setParam('mergeRows', true) },
		});
	}
	if (model.strips.length && params.mergeRows) {
		items.push({ level: 'info', text: t('check.merged', model.strips.length, Math.round(params.stripPaste * 100)), note: t('check.merged.note'), points: model.strips });
	}
	if (analysis.narrowApertures) {
		items.push({ level: 'bad', text: t('check.narrow', analysis.narrowApertures, fmt(analysis.minOpening), params.nozzle), points: issues('narrowAperture') });
	}
	if (analysis.thinWebs) {
		items.push({ level: 'warn', text: t('check.web', analysis.thinWebs, fmt(analysis.minWeb)), points: issues('thinWeb') });
	}
	if (model.webFix.count) {
		items.push({ level: 'info', text: t('check.webFix', model.webFix.count, params.nozzle) });
	}
	if (params.frameMode !== 'none' && model.frameHeight < 0.4) {
		items.push({ level: 'warn', text: t('check.frameLow', fmt(model.frameHeight)) });
	}
	for (const warning of data.warnings.slice(0, 3)) {
		items.push({ level: 'warn', text: t('check.gerber', warning) });
	}
	if (!items.some(i => i.level === 'bad' || i.level === 'warn')) {
		items.unshift({ level: 'ok', text: t('check.ok') });
	}
	return items;
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
