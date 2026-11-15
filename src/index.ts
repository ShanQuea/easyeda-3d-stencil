// 扩展入口。主进程里没有 DOM，所有界面和计算都在 iframe 里，这边只负责开窗
import extensionConfig from '../extension.json' with { type: 'json' };
import { dockRect, PAGE, WINDOW_IDS, windowProps } from './window';

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {}

export async function openStencil(): Promise<void> {
	for (const id of WINDOW_IDS) {
		if (await eda.sys_IFrame.isIFrameAlreadyExist(id)) {
			await eda.sys_IFrame.showIFrame(id);
			return;
		}
	}
	const props = windowProps(eda.sys_I18n.text('3D Printed Stencil'));
	// 主进程里不一定拿得到视口大小，拿不到就先开个默认的，界面加载后自己挪到右边
	const g = globalThis as { innerWidth?: number; innerHeight?: number };
	if (g.innerWidth && g.innerHeight) {
		const r = dockRect(g.innerWidth, g.innerHeight);
		await eda.sys_IFrame.openIFrame(PAGE, r.width, r.height, WINDOW_IDS[0], { ...props, x: r.x, y: r.y });
	}
	else {
		await eda.sys_IFrame.openIFrame(PAGE, 1180, 760, WINDOW_IDS[0], props);
	}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('About text', undefined, undefined, extensionConfig.version, extensionConfig.homepage),
		eda.sys_I18n.text('3D Printed Stencil'),
	);
}
