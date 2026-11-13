// 把 src/app 打成一个自包含的 HTML。
// 扩展的 iframe 只认单个 html 文件（旁边的 js/css 不保证会被带上），GitHub Pages 也直接用这份
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import fs from 'fs-extra';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'src/app');
const outFile = path.join(root, 'iframe/index.html');

async function build(): Promise<void> {
	const [js, css] = await Promise.all([
		esbuild.build({
			entryPoints: [path.join(appDir, 'main.ts')],
			bundle: true,
			minify: true,
			format: 'iife',
			platform: 'browser',
			target: 'es2020',
			write: false,
			legalComments: 'none',
		}),
		esbuild.build({ entryPoints: [path.join(appDir, 'style.css')], bundle: true, minify: true, write: false }),
	]);
	const template = await fs.readFile(path.join(appDir, 'index.html'), 'utf-8');
	// 用函数做替换，免得 js 里的 $& 之类被当成替换模式；</script 要转义，不然会把内联脚本截断
	const html = template
		.replace('/*__CSS__*/', () => css.outputFiles[0].text.trim())
		.replace('/*__JS__*/', () => js.outputFiles[0].text.trim().replace(/<\/script/gi, '<\\/script'));
	await fs.outputFile(outFile, html);
	console.log(`iframe/index.html  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
}

build().catch((error) => {
	console.error(error);
	process.exit(1);
});
