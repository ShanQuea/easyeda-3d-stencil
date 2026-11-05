// 扩展入口。主进程里没有 DOM，所有界面和计算都在 iframe 里，这边只负责开窗
import extensionConfig from '../extension.json' with { type: 'json' };

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {}

export function openStencil(): void {
	eda.sys_IFrame.openIFrame('/iframe/index.html', 1180, 760, 'easyeda-3d-stencil', {
		maximizeButton: true,
		minimizeButton: true,
		title: eda.sys_I18n.text('3D Printed Stencil'),
	});
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('About text', undefined, undefined, extensionConfig.version, extensionConfig.homepage),
		eda.sys_I18n.text('3D Printed Stencil'),
	);
}
