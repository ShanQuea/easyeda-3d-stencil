// 和宿主打交道的部分：在嘉立创EDA 的 iframe 里走 eda.* 接口，单独打开网页时走浏览器自己的
import type { GerberSources, LayerRole } from '../core';
import JSZip from 'jszip';
import { pickLayers } from '../core';

// iframe 里 eda 是直接挂在全局上的
export const inEda = typeof (globalThis as { eda?: unknown }).eda !== 'undefined';

export interface LoadedBoard {
	name: string;
	sources: GerberSources;
}

const ROLES: LayerRole[] = ['outline', 'topPaste', 'bottomPaste'];

function hasAnyLayer(sources: GerberSources): boolean {
	return ROLES.some(role => sources[role]);
}

export async function readZip(data: Blob | ArrayBuffer): Promise<GerberSources> {
	const zip = await JSZip.loadAsync(data);
	const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
	const picked = pickLayers(names);
	const sources: GerberSources = {};
	for (const role of ROLES) {
		const name = picked[role];
		if (name) {
			sources[role] = await zip.files[name].async('string');
		}
	}
	return sources;
}

// 拖进来的可能是一个 zip，也可能是几个散的 Gerber 文件
export async function readFiles(files: File[]): Promise<LoadedBoard | undefined> {
	const zipFile = files.find(f => /\.zip$/i.test(f.name));
	if (zipFile) {
		const sources = await readZip(zipFile);
		return hasAnyLayer(sources) ? { name: zipFile.name.replace(/\.zip$/i, ''), sources } : undefined;
	}
	const picked = pickLayers(files.map(f => f.name));
	const sources: GerberSources = {};
	for (const role of ROLES) {
		const file = files.find(f => f.name === picked[role]);
		if (file) {
			sources[role] = await file.text();
		}
	}
	if (!hasAnyLayer(sources)) {
		return undefined;
	}
	const first = files.find(f => f.name === picked.topPaste) ?? files[0];
	return { name: first.name.replace(/\.[^.]+$/, ''), sources };
}

export async function readFromEda(): Promise<LoadedBoard | undefined> {
	// 不传图层参数，整套导出来再自己挑，省得猜各版本的图层 ID
	const file = await eda.pcb_ManufactureData.getGerberFile();
	if (!file) {
		return undefined;
	}
	const sources = await readZip(file);
	if (!hasAnyLayer(sources)) {
		return undefined;
	}
	let name = file.name.replace(/\.zip$/i, '') || 'pcb';
	try {
		const pcb = await eda.dmt_Pcb.getCurrentPcbInfo();
		const project = await eda.dmt_Project.getCurrentProjectInfo();
		name = pcb?.name || project?.friendlyName || name;
	}
	catch {
		// 拿不到名字无所谓
	}
	return { name, sources };
}

// 叠层接口是 beta 的，字段没文档，只能猜着读：读不准就返回 undefined 让用户自己填
export async function readBoardThickness(): Promise<number | undefined> {
	try {
		const stack = await eda.pcb_Layer.getCurrentPhysicalStackingConfiguration();
		if (!stack?.list?.length) {
			return undefined;
		}
		let total = 0;
		for (const layer of stack.list) {
			for (const [key, value] of Object.entries(layer)) {
				if (/thick/i.test(key)) {
					const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
					if (Number.isFinite(n)) {
						total += n;
					}
					break;
				}
			}
		}
		// 大于 10 多半是 mil
		const mm = total > 10 ? total * 0.0254 : total;
		return mm >= 0.2 && mm <= 6 ? Math.round(mm * 100) / 100 : undefined;
	}
	catch {
		return undefined;
	}
}

export async function hostLanguage(): Promise<'zh' | 'en'> {
	let language = navigator.language;
	if (inEda) {
		try {
			language = await eda.sys_I18n.getCurrentLanguage();
		}
		catch {
			// 用浏览器语言
		}
	}
	return /^zh/i.test(language) ? 'zh' : 'en';
}

export async function saveFile(data: ArrayBuffer, fileName: string, mime: string): Promise<void> {
	const blob = new Blob([data], { type: mime });
	if (inEda) {
		try {
			await eda.sys_FileSystem.saveFile(blob, fileName);
			return;
		}
		catch {
			// 落到下面的浏览器下载
		}
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
