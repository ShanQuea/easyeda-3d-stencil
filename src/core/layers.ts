export type LayerRole = 'outline' | 'topPaste' | 'bottomPaste';

const RULES: Array<{ role: LayerRole; patterns: RegExp[] }> = [
	{
		role: 'topPaste',
		patterns: [/\.gtp$/i, /\.crc$/i, /toppaste/i, /top[-_. ]?paste/i, /paste[-_. ]?top/i, /f[-_.]paste/i, /\.tcream/i, /tcream/i],
	},
	{
		role: 'bottomPaste',
		patterns: [/\.gbp$/i, /\.crs$/i, /bottompaste/i, /bot(?:tom)?[-_. ]?paste/i, /paste[-_. ]?bot/i, /b[-_.]paste/i, /bcream/i],
	},
	{
		role: 'outline',
		patterns: [/\.gko$/i, /\.gm1$/i, /\.gml$/i, /\.oln$/i, /boardoutline/i, /edge[-_. ]?cuts/i, /outline/i, /profile/i, /\.gm\d+$/i],
	},
];

export function detectLayer(fileName: string): LayerRole | undefined {
	const base = fileName.split(/[\\/]/).pop() ?? fileName;
	for (const rule of RULES) {
		if (rule.patterns.some(p => p.test(base))) {
			return rule.role;
		}
	}
	return undefined;
}

export function pickLayers(fileNames: string[]): Partial<Record<LayerRole, string>> {
	const picked: Partial<Record<LayerRole, string>> = {};
	for (const rule of RULES) {
		let bestRank = Infinity;
		for (const name of fileNames) {
			const base = name.split(/[\\/]/).pop() ?? name;
			const rank = rule.patterns.findIndex(p => p.test(base));
			if (rank >= 0 && rank < bestRank) {
				bestRank = rank;
				picked[rule.role] = name;
			}
		}
	}
	return picked;
}
