/** @file Codex-specific tagged context extraction shared by message renderers. */

const CODEX_CONTEXT_TAGS = [
	{ tag: "permissions instructions", title: "Permissions Instructions" },
	{ tag: "collaboration_mode", title: "Collaboration Mode" },
	{ tag: "skills_instructions", title: "Skills Instructions" },
	{ tag: "environment_context", title: "Environment Context" },
] as const;

/** Extracts raw or HTML-escaped XML-like blocks while preserving surrounding text. */
export function extractTaggedBlocks(content: string, tagName: string): { blocks: string[]; remaining: string } {
	const escapedPattern = new RegExp(`&lt;${tagName}&gt;([\\s\\S]*?)&lt;/${tagName}&gt;`, "g");
	const rawPattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "g");
	const blocks: string[] = [];
	for (const regex of [escapedPattern, rawPattern]) {
		let match;
		while ((match = regex.exec(content)) !== null) blocks.push(match[1].trim());
	}
	return { blocks, remaining: content.replace(escapedPattern, "").replace(rawPattern, "").trim() };
}

/** Keeps nested tag examples inside a Codex context block intact. */
function extractOutermostTaggedBlock(content: string, tagName: string): { block: string | null; remaining: string } {
	const variants = [
		{ open: `<${tagName}>`, close: `</${tagName}>` },
		{ open: `&lt;${tagName}&gt;`, close: `&lt;/${tagName}&gt;` },
	];
	const trimmed = content.trim();
	for (const { open, close } of variants) {
		if (!trimmed.startsWith(open)) continue;
		const lastClose = trimmed.lastIndexOf(close);
		if (lastClose <= open.length) return { block: null, remaining: content };
		const block = trimmed.slice(open.length, lastClose).trim();
		const after = trimmed.slice(lastClose + close.length).trim();
		const leading = content.slice(0, content.indexOf(trimmed));
		return { block, remaining: (leading + after).trim() };
	}
	return { block: null, remaining: content };
}

/** Moves known leading Codex context blocks into collapsible sections. */
export function extractCodexContextSections(content: string): {
	sections: Array<{ title: string; blocks: string[] }>;
	remaining: string;
} {
	const sections: Array<{ title: string; blocks: string[] }> = [];
	let remaining = content;
	for (const { tag, title } of CODEX_CONTEXT_TAGS) {
		const extracted = extractOutermostTaggedBlock(remaining, tag);
		if (extracted.block) {
			sections.push({ title, blocks: [extracted.block] });
			remaining = extracted.remaining;
		}
	}
	return { sections, remaining };
}
