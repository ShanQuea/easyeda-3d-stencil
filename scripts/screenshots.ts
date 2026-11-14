// 用本机的 Edge/Chrome 给 README 截图，顺带把 logo 渲染成 png。先跑 npm run build:app
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { chromium } from 'playwright-core';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = pathToFileURL(path.join(root, 'iframe/index.html')).href;
const docs = path.join(root, 'docs');

const SHOTS = [
	{ file: 'screenshot-zh.png', query: '?lang=zh', yaw: -1.15, pitch: 0.8, zoom: 0.92 },
	{ file: 'screenshot-en.png', query: '?lang=en', yaw: -1.15, pitch: 0.8, zoom: 0.92 },
	{ file: 'assembled.png', query: '?lang=zh&view=assembled', yaw: -1.9, pitch: 0.62, zoom: 0.95 },
	// 下面几张只截预览区，README 里拼成一排
	{ file: 'frame-full.png', query: '?lang=zh&frame=full', yaw: -1.15, pitch: 0.8, zoom: 0.95, stage: true },
	{ file: 'frame-corners.png', query: '?lang=zh&frame=corners', yaw: -1.15, pitch: 0.8, zoom: 0.95, stage: true },
	{ file: 'frame-none.png', query: '?lang=zh&frame=none', yaw: -1.15, pitch: 0.8, zoom: 0.95, stage: true },
	{ file: 'check-nozzle-04.png', query: '?lang=zh&nozzle=0.4', yaw: -1.5708, pitch: 1.25, zoom: 2.3, stage: true },
	{ file: 'check-nozzle-02.png', query: '?lang=zh&nozzle=0.2', yaw: -1.5708, pitch: 1.25, zoom: 2.3, stage: true },
];

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1c2330"/><stop offset="1" stop-color="#0f1319"/></linearGradient></defs>
<rect width="500" height="500" rx="96" fill="url(#g)"/>
<rect x="70" y="120" width="360" height="260" rx="34" fill="none" stroke="#4c9dff" stroke-width="26"/>
<g fill="#e6e9ee">
<rect x="130" y="180" width="58" height="42" rx="7"/><rect x="221" y="180" width="58" height="42" rx="7"/><rect x="312" y="180" width="58" height="42" rx="7"/>
<rect x="130" y="262" width="26" height="62" rx="6"/><rect x="183" y="262" width="26" height="62" rx="6"/><rect x="237" y="262" width="26" height="62" rx="6"/><rect x="290" y="262" width="26" height="62" rx="6"/><rect x="344" y="262" width="26" height="62" rx="6"/>
</g></svg>`;

async function main(): Promise<void> {
	await fs.ensureDir(docs);
	const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch({ channel: 'chrome' }));
	const context = await browser.newContext({ viewport: { width: 1280, height: 780 }, deviceScaleFactor: 2 });
	for (const shot of SHOTS) {
		const tab = await context.newPage();
		tab.on('pageerror', error => console.error(shot.file, error.message));
		await tab.goto(page + shot.query);
		await tab.waitForSelector('#stats div');
		await tab.evaluate(({ yaw, pitch, zoom }) => (window as any).__stencil.viewer()?.setAngles(yaw, pitch, zoom), shot);
		await tab.waitForTimeout(400);
		await tab.screenshot({ path: path.join(docs, shot.file), clip: 'stage' in shot ? { x: 304, y: 0, width: 976, height: 780 } : undefined });
		await tab.close();
		console.log(shot.file);
	}

	const logo = await browser.newPage({ viewport: { width: 500, height: 500 } });
	await logo.setContent(`<body style="margin:0;background:transparent">${LOGO}</body>`);
	await logo.screenshot({ path: path.join(root, 'images/logo.png'), omitBackground: true });
	await fs.writeFile(path.join(docs, 'logo.svg'), LOGO);
	await browser.close();
}

void main();
