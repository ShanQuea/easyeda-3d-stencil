// 用本机的 Edge/Chrome 给 README 截图。先跑 npm run build:app
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

	await browser.close();
}

void main();
