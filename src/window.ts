// 扩展入口和界面共用的窗口参数
export const WINDOW_IDS = ['easyeda-3d-stencil', 'easyeda-3d-stencil-alt'];
export const PAGE = '/iframe/index.html';

// 停在右边，左边留给 PCB 对照。宽度封顶，界面里按宽度判断是否已经靠右
export const DOCK_MAX = 960;

export function dockRect(vw: number, vh: number): { width: number; height: number; x: number; y: number } {
	const width = Math.round(Math.min(DOCK_MAX, Math.max(560, vw * 0.42)));
	const height = Math.round(Math.max(480, vh - 160));
	return { width, height, x: Math.max(0, vw - width - 24), y: 96 };
}

export function windowProps(title: string) {
	return { maximizeButton: true, minimizeButton: true, grayscaleMask: false, title };
}
