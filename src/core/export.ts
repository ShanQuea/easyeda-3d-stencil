import type { Mesh } from './mesh';
import JSZip from 'jszip';

export function toStl(mesh: Mesh, title = 'EasyEDA 3D Stencil'): ArrayBuffer {
	const { vertices, triangles } = mesh;
	const count = triangles.length / 3;
	const buffer = new ArrayBuffer(84 + count * 50);
	const view = new DataView(buffer);
	// 头部不能以 "solid" 开头，否则部分软件会当成 ASCII STL
	const header = `Binary STL - ${title}`.slice(0, 80);
	for (let i = 0; i < header.length; i++) {
		view.setUint8(i, header.charCodeAt(i) & 0x7F);
	}
	view.setUint32(80, count, true);
	let offset = 84;
	for (let i = 0; i < triangles.length; i += 3) {
		const a = triangles[i] * 3;
		const b = triangles[i + 1] * 3;
		const c = triangles[i + 2] * 3;
		const ux = vertices[b] - vertices[a];
		const uy = vertices[b + 1] - vertices[a + 1];
		const uz = vertices[b + 2] - vertices[a + 2];
		const vx = vertices[c] - vertices[a];
		const vy = vertices[c + 1] - vertices[a + 1];
		const vz = vertices[c + 2] - vertices[a + 2];
		let nx = uy * vz - uz * vy;
		let ny = uz * vx - ux * vz;
		let nz = ux * vy - uy * vx;
		const length = Math.hypot(nx, ny, nz) || 1;
		nx /= length;
		ny /= length;
		nz /= length;
		view.setFloat32(offset, nx, true);
		view.setFloat32(offset + 4, ny, true);
		view.setFloat32(offset + 8, nz, true);
		offset += 12;
		for (const p of [a, b, c]) {
			view.setFloat32(offset, vertices[p], true);
			view.setFloat32(offset + 4, vertices[p + 1], true);
			view.setFloat32(offset + 8, vertices[p + 2], true);
			offset += 12;
		}
		view.setUint16(offset, 0, true);
		offset += 2;
	}
	return buffer;
}

const XML_ESCAPES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' };

function escapeXml(text: string): string {
	return text.replace(/[<>&"]/g, ch => XML_ESCAPES[ch]);
}

export function to3mfModel(mesh: Mesh, title = 'EasyEDA 3D Stencil'): string {
	const { vertices, triangles } = mesh;
	const parts: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>\n',
		'<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
		` <metadata name="Title">${escapeXml(title)}</metadata>\n`,
		' <metadata name="Application">EasyEDA 3D Stencil</metadata>\n',
		' <resources>\n  <object id="1" type="model">\n   <mesh>\n    <vertices>\n',
	];
	const fmt = (v: number): string => String(Math.round(v * 10000) / 10000);
	for (let i = 0; i < vertices.length; i += 3) {
		parts.push(`     <vertex x="${fmt(vertices[i])}" y="${fmt(vertices[i + 1])}" z="${fmt(vertices[i + 2])}"/>\n`);
	}
	parts.push('    </vertices>\n    <triangles>\n');
	for (let i = 0; i < triangles.length; i += 3) {
		parts.push(`     <triangle v1="${triangles[i]}" v2="${triangles[i + 1]}" v3="${triangles[i + 2]}"/>\n`);
	}
	parts.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1"/>\n </build>\n</model>\n');
	return parts.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

export async function to3mf(mesh: Mesh, title?: string): Promise<ArrayBuffer> {
	const zip = new JSZip();
	zip.file('[Content_Types].xml', CONTENT_TYPES);
	zip.file('_rels/.rels', RELS);
	zip.file('3D/3dmodel.model', to3mfModel(mesh, title));
	return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
