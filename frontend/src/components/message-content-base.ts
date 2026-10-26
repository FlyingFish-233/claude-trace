/** @file Shared markdown, thinking, tool-call and JSON message rendering. */
import { html, TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { ContentBlockParam, Message, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { ToolPreviewBase } from "./tool-preview-base";
import { markdownToHtml } from "../utils/markdown";
import { extractCodexContextSections, extractTaggedBlocks } from "../utils/context-sections";

/** Common content rendering used by trace and training timeline items. */
export abstract class MessageContentBase extends ToolPreviewBase {
	protected renderThinkingBlock(thinking: string): TemplateResult {
		const content = thinking.trim();
		if (!content) {
			return html``;
		}

		return this.renderCollapsibleSection(
			"Thinking",
			html`<div class="text-gray-400 markdown-content">${unsafeHTML(markdownToHtml(content))}</div>`,
			{
				titleClasses: "text-gray-500 italic",
				containerClasses: "mt-4 mb-4",
			},
		);
	}

	/**
	 * Renders message content blocks — text, thinking, and tool_use with paired results.
	 *
	 * @param toolResults - Map of tool_use_id → tool_result hoisted by the processor.
	 */
	protected formatContent(
		content: string | ContentBlockParam[],
		toolResults?: Record<string, any>,
		showContextBlocks = true,
	): TemplateResult {
		if (typeof content === "string") {
			return this.formatStringContent(content, showContextBlocks);
		}

		if (Array.isArray(content)) {
			return html`
				${content.map((block) => {
					if (block.type === "text") {
						return this.formatStringContent(block.text, showContextBlocks);
					} else if (block.type === "thinking") {
						const thinkingBlock = block as any;
						return this.renderThinkingBlock(thinkingBlock.thinking || "");
					} else if (block.type === "tool_result") {
						// Results are rendered next to their tool_use when a lookup is available.
						return toolResults?.[(block as any).tool_use_id]
							? html``
							: this.renderToolResult(block);
					} else if (block.type === "tool_use") {
						const toolUse = block as any;
						const toolResult = toolResults?.[toolUse.id];

						if (block.name === "TodoWrite" || block.name === "Edit" || block.name === "MultiEdit") {
							return this.renderToolContainer(block, toolResult);
						}
						if (block.name === "Write") {
							const customContent = html`
								<div class="bg-vs-bg-secondary p-4 text-vs-text hidden">
									${this.renderToolUseContent(block)}
								</div>
								<div
									class="bg-vs-bg-secondary mx-4 p-4 text-vs-text cursor-pointer hover:bg-vs-border transition-colors"
									@click=${this.toggleWriteContent}
								>
									${this.renderWritePreview(block)}
								</div>
							`;
							return html`
								<div class="mt-4 mb-4">
									<div class="text-vs-type px-4 break-all">${this.getToolDisplayName(block)}</div>
									${customContent} ${toolResult ? this.renderToolResult(toolResult, block) : ""}
								</div>
							`;
						}
						return this.renderToolContainer(block, toolResult, {
							isCollapsible: true,
							isCollapsed: true,
							isClickToExpand: true,
						});
					}
					return html`<pre class="mb-4">${JSON.stringify(block, null, 2)}</pre>`;
				})}
			`;
		}

		return html`<pre>${JSON.stringify(content, null, 2)}</pre>`;
	}

	/**
	 * Finds all occurrences of `<tag>...</tag>` (raw or HTML-escaped) and returns
	 * inner text plus the string with those blocks removed.
	 */
	protected renderTaggedCollapsibleSections(
		title: string,
		blocks: string[],
	): TemplateResult {
		if (blocks.length === 0) {
			return html``;
		}

		return this.renderCollapsibleSection(
			title,
			html`<div class="text-vs-muted">
				${blocks.map(
					(block, index) => html`
						<div class="trace-block trace-message-system mb-4">
							<div class="trace-block-header">
								${blocks.length > 1 ? `${title} ${index + 1}` : title}
							</div>
							<div class="trace-block-body markdown-content">${unsafeHTML(markdownToHtml(block))}</div>
						</div>
					`,
				)}
			</div>`,
			{
				titleClasses: "text-vs-muted",
				containerClasses: "mt-4 mb-4",
				count: blocks.length > 1 ? blocks.length : undefined,
			},
		);
	}

	/** Codex injects these XML-like tags in user messages; extracted into collapsible sections. */
	protected formatStringContent(content: string, showContextBlocks = true): TemplateResult {
		const { sections: codexContextSections, remaining: afterCodexContext } =
			extractCodexContextSections(content);
		const { blocks: extremelyImportantBlocks, remaining: afterExtremelyImportant } =
			extractTaggedBlocks(afterCodexContext, "EXTREMELY_IMPORTANT");
		const { blocks: systemReminderBlocks, remaining: mainContent } = extractTaggedBlocks(
			afterExtremelyImportant,
			"system-reminder",
		);

		return html`
			${mainContent ? html`<div class="mt-4 markdown-content">${unsafeHTML(markdownToHtml(mainContent))}</div>` : ""}
			${showContextBlocks
				? html`
						${codexContextSections.map(({ title, blocks }) => this.renderTaggedCollapsibleSections(title, blocks))}
						${this.renderTaggedCollapsibleSections("Extremely Important", extremelyImportantBlocks)}
						${this.renderTaggedCollapsibleSections("System Reminder", systemReminderBlocks)}
					`
				: ""}
		`;
	}

	/** Converts system prompt (string or block array) to HTML via markdown. */
	protected formatSystem(system: string | TextBlockParam[] | undefined): string {
		if (!system) return "";

		if (typeof system === "string") {
			return markdownToHtml(system);
		}

		if (Array.isArray(system)) {
			const textContent = system
				.map((block) => {
					if (block.type === "text") {
						return block.text;
					}
					return JSON.stringify(block, null, 2);
				})
				.join("\n");
			return markdownToHtml(textContent);
		}

		return JSON.stringify(system, null, 2);
	}

	/** Renders the final assistant response message for a conversation thread. */
	protected formatResponseContent(response: Message): TemplateResult {
		if (!response) return html``;

		if (response.content && Array.isArray(response.content)) {
			return html`
				${response.content.map((block) => {
					if (block.type === "text") {
						return html`<div class="mt-4 markdown-content">${unsafeHTML(markdownToHtml(block.text))}</div>`;
					} else if (block.type === "thinking") {
						const thinkingBlock = block as any;
						return this.renderThinkingBlock(thinkingBlock.thinking || "");
					} else if (block.type === "tool_use") {
						if (block.name === "TodoWrite") {
							return html`
								<div class="mt-4 mb-4">
									<div class="text-vs-type px-4 break-all">${this.getToolDisplayName(block)}</div>
									<div class="bg-vs-bg-secondary mx-4 p-4 text-vs-text">
										${this.renderToolUseContent(block)}
									</div>
								</div>
							`;
						}
						return html`
							<div class="mt-4 mb-4">
								<div
									class="text-vs-type px-4 py-2 break-all cursor-pointer hover:text-white transition-colors"
									@click=${this.toggleContent}
								>
									<span class="mr-2">[+]</span>
									${this.getToolDisplayName(block)}
								</div>
								<div class="bg-vs-bg-secondary mx-4 p-4 text-vs-text hidden">
									${this.renderToolUseContent(block)}
								</div>
							</div>
						`;
					}
					return html`<pre class="mb-4">${JSON.stringify(block, null, 2)}</pre>`;
				})}
			`;
		}

		return html`<pre>${JSON.stringify(response, null, 2)}</pre>`;
	}

	/** Pretty-printed JSON disclosure shared by context and timeline items. */
	private renderJson(title: string, value: unknown, kind: "raw" | "parsed"): TemplateResult {
		let json = "";
		try {
			json = JSON.stringify(value, null, 2);
		} catch (error) {
			json = `Unable to serialize JSON: ${String(error)}`;
		}

		return html`
			<details class=${kind === "parsed" ? "trace-json-details trace-parsed-json" : "trace-json-details"}>
				<summary>${kind === "raw" ? html`原始 JSON · ${title}` : html`解析后 JSON · ${title}`}</summary>
				<pre>${json}</pre>
			</details>
		`;
	}

	protected renderRawJson(title: string, value: unknown): TemplateResult {
		return this.renderJson(title, value, "raw");
	}

	protected renderParsedJson(title: string, value: unknown): TemplateResult {
		return this.renderJson(title, value, "parsed");
	}
}
