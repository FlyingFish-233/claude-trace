/** @file Shared collapsible tool previews and schema rendering. */
import { LitElement, html, TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import * as Diff from "diff";
import type { ToolUnion } from "@anthropic-ai/sdk/resources/messages";
import { markdownToHtml } from "../utils/markdown";

/** Shared behavior for the conversation's message and tool views. */
export abstract class ToolPreviewBase extends LitElement {
	protected handleToggle(
		e: Event,
		options: {
			type?: "content" | "write" | "custom";
			targetSelector?: string;
			toggleSelector?: string;
			customHandler?: (element: HTMLElement, isHidden: boolean) => void;
		} = {},
	) {
		const { type = "content", targetSelector, toggleSelector, customHandler } = options;
		const currentElement = e.currentTarget as HTMLElement;

		if (type === "write") {
			const fullContent = currentElement.previousElementSibling as HTMLElement;
			if (fullContent) {
				const isExpanded = !fullContent.classList.contains("hidden");
				if (isExpanded) {
					fullContent.classList.add("hidden");
					currentElement.classList.remove("hidden");
				} else {
					fullContent.classList.remove("hidden");
					currentElement.classList.add("hidden");
				}
			}
			return;
		}

		// Default content toggle behavior
		const target = targetSelector
			? (currentElement.querySelector(targetSelector) as HTMLElement)
			: (currentElement.nextElementSibling as HTMLElement);
		const toggle = toggleSelector
			? (currentElement.querySelector(toggleSelector) as HTMLElement)
			: (currentElement.querySelector("span:first-child") as HTMLElement);

		if (target) {
			const isHidden = target.classList.contains("hidden");

			if (customHandler) {
				customHandler(target, isHidden);
			} else {
				target.classList.toggle("hidden", !isHidden);
				if (toggle) {
					toggle.textContent = isHidden ? "[-]" : "[+]";
				}
			}
		}
	}

	/** Delegates to {@link handleToggle} with default content-toggle behavior. */
	protected toggleContent(e: Event) {
		this.handleToggle(e);
	}

	/** Swaps Write-tool preview vs full content panels. */
	protected toggleWriteContent(e: Event) {
		this.handleToggle(e, { type: "write" });
	}

	/** Renders an expandable "Thinking" block with markdown formatting. */
	protected formatSingleParam(toolName: string, paramValue: string | undefined, paramName: string = ""): TemplateResult {
		return paramValue
			? html`${toolName}(<span class="text-vs-text">${this.unescapeHtml(paramValue)}</span>)`
			: html`${toolName}`;
	}

	/** Formats `ToolName(a, b, ...)` header text for multi-argument tools. */
	protected formatMultiParam(toolName: string, params: string[]): TemplateResult {
		return params.length > 0
			? html`${toolName}(<span class="text-vs-text">${params.join(", ")}</span>)`
			: html`${toolName}`;
	}

	/** Decodes HTML entities in tool argument strings for display. */
	protected unescapeHtml(str: string): string {
		const div = document.createElement("div");
		div.innerHTML = str;
		return div.textContent || div.innerText || "";
	}

	/** Wraps tool output in a horizontally scrollable container. */
	protected wrapInScrollable(content: TemplateResult | string, usePreFormatting: boolean = true): TemplateResult {
		if (usePreFormatting && typeof content === "string") {
			return html`
				<div class="overflow-x-auto">
					<pre class="text-vs-text m-0" style="white-space: pre; font-family: monospace;">${content}</pre>
				</div>
			`;
		}
		return html` <div class="overflow-x-auto">${content}</div> `;
	}

	/**
	 * Generic `[+]/[-]` collapsible section used for system prompt, tools, and tags.
	 *
	 * @param count - Optional item count appended to the title, e.g. "Tools (12)".
	 */
	protected renderCollapsibleSection(
		title: string,
		content: TemplateResult,
		options: {
			isExpanded?: boolean;
			titleClasses?: string;
			containerClasses?: string;
			count?: number;
		} = {},
	): TemplateResult {
		const { isExpanded = false, titleClasses = "", containerClasses = "", count } = options;
		const expandedClass = isExpanded ? "" : "hidden";
		const toggleSymbol = isExpanded ? "[-]" : "[+]";
		const displayTitle = count !== undefined ? `${title} (${count})` : title;

		return html`
			<div class="${containerClasses}">
				<div class="cursor-pointer hover:text-white transition-colors ${titleClasses}" @click=${this.toggleContent}>
					<span class="mr-2">${toggleSymbol}</span>
					<span>${displayTitle}</span>
				</div>
				<div class="${expandedClass} mt-4">${content}</div>
			</div>
		`;
	}

	/** Human-readable one-line summary for each known Claude Code tool name. */
	protected getToolDisplayName(toolUse: any, toolResult?: any): TemplateResult {
		const toolName = toolUse.name;
		const input = toolUse.input;

		switch (toolName) {
			case "Read":
				return this.formatSingleParam(toolName, input?.file_path);
			case "Bash":
				return this.formatSingleParam(toolName, input?.command);
			case "Write":
				return this.formatSingleParam(toolName, input?.file_path);
			case "Glob":
				if (input?.pattern) {
					const params = [this.unescapeHtml(input.pattern)];
					if (input?.path) params.push(this.unescapeHtml(input.path));
					return this.formatMultiParam(toolName, params);
				}
				return html`${toolName}`;
			case "Grep":
				if (input?.pattern) {
					const params = [this.unescapeHtml(input.pattern)];
					if (input?.include) params.push(this.unescapeHtml(input.include));
					if (input?.path) params.push(this.unescapeHtml(input.path));
					return this.formatMultiParam(toolName, params);
				}
				return html`${toolName}`;
			case "LS":
				if (input?.path) {
					const params = [this.unescapeHtml(input.path)];
					if (input?.ignore) {
						const ignoreStr = input.ignore.map((p: string) => this.unescapeHtml(p)).join(", ");
						params.push(`ignore: ${ignoreStr}`);
					}
					return this.formatMultiParam(toolName, params);
				}
				return html`${toolName}`;
			case "Edit":
				return input?.file_path
					? this.formatSingleParam(toolName, this.unescapeHtml(input.file_path).split("/").pop())
					: html`${toolName}`;
			case "MultiEdit":
				if (input?.file_path) {
					const fileName = this.unescapeHtml(input.file_path).split("/").pop() || input.file_path;
					const editCount = input?.edits ? input.edits.length : 0;
					return this.formatMultiParam(toolName, [fileName, `${editCount} edits`]);
				}
				return html`${toolName}`;
			case "NotebookRead":
				return input?.notebook_path
					? this.formatSingleParam(toolName, this.unescapeHtml(input.notebook_path).split("/").pop())
					: html`${toolName}`;
			case "NotebookEdit":
				if (input?.notebook_path && input?.cell_number !== undefined) {
					const fileName = this.unescapeHtml(input.notebook_path).split("/").pop();
					const cellNum = input.cell_number;
					const mode = input?.edit_mode || "replace";
					return this.formatMultiParam(toolName, [fileName, `cell ${cellNum}`, mode]);
				}
				return html`${toolName}`;
			case "WebFetch":
				return input?.url ? this.formatSingleParam(toolName, input.url) : html`${toolName}`;
			case "WebSearch":
				return input?.query ? this.formatSingleParam(toolName, input.query) : html`${toolName}`;
			default:
				return html`${toolName}`;
		}
	}

	/** Renders expanded tool input — diffs for Edit, todos for TodoWrite, JSON fallback. */
	protected renderToolUseContent(toolUse: any): TemplateResult {
		const toolName = toolUse.name;
		const input = toolUse.input;

		if (toolName === "TodoWrite" && input?.todos) {
			const todos = input.todos;

			return this.wrapInScrollable(
				html`${todos.map((todo: any) => {
					const statusClass =
						todo.status === "completed"
							? "line-through text-vs-text"
							: todo.status === "in_progress"
								? "text-green-400"
								: "text-vs-muted";

					return html`
						<div class="overflow-hidden whitespace-nowrap text-ellipsis ${statusClass}">• ${todo.content}</div>
					`;
				})}`,
				false,
			);
		}

		if (toolName === "NotebookEdit" && input?.new_source) {
			const content = input.new_source;

			return this.wrapInScrollable(content);
		}

		if (toolName === "Write" && input?.content) {
			const content = input.content;

			return this.wrapInScrollable(content);
		}

		if (toolName === "MultiEdit" && input?.edits) {
			const edits = input.edits;

			return this.wrapInScrollable(
				html`${edits.map((edit: any, index: number) => {
					const oldStr = edit.old_string;
					const newStr = edit.new_string;

					const diffLines = this.renderDiff(oldStr, newStr);

					return html`
						<div class="mb-4">
							<div class="text-vs-muted mb-2">Edit ${index + 1}:</div>
							<div>${diffLines}</div>
						</div>
					`;
				})}`,
				false,
			);
		}

		if (toolName === "Edit" && input?.old_string && input?.new_string) {
			const oldStr = input.old_string;
			const newStr = input.new_string;

			const diffLines = this.renderDiff(oldStr, newStr);

			return this.wrapInScrollable(html`${diffLines}`, false);
		}

		if (toolName === "WebFetch" && input?.url && input?.prompt) {
			return this.wrapInScrollable(
				html`
					<div class="mb-3">
						<div class="text-vs-muted mb-1">URL:</div>
						<div class="text-vs-text">${input.url}</div>
					</div>
					<div>
						<div class="text-vs-muted mb-1">Prompt:</div>
						<div class="text-vs-text">${input.prompt}</div>
					</div>
				`,
				false,
			);
		}

		if (toolName === "WebSearch" && input?.query) {
			const params = [];
			params.push(html`
				<div class="mb-3">
					<div class="text-vs-muted mb-1">Query:</div>
					<div class="text-vs-text">${input.query}</div>
				</div>
			`);

			if (input?.allowed_domains) {
				params.push(html`
					<div class="mb-3">
						<div class="text-vs-muted mb-1">Allowed Domains:</div>
						<div class="text-vs-text">${input.allowed_domains.join(", ")}</div>
					</div>
				`);
			}

			if (input?.blocked_domains) {
				params.push(html`
					<div class="mb-3">
						<div class="text-vs-muted mb-1">Blocked Domains:</div>
						<div class="text-vs-text">${input.blocked_domains.join(", ")}</div>
					</div>
				`);
			}

			return this.wrapInScrollable(html`${params}`, false);
		}

		// Default: show JSON parameters
		return this.wrapInScrollable(JSON.stringify(input, null, 2));
	}

	/** Collapsible tool_result output plus optional raw tool_use JSON dump. */
	protected renderToolResult(toolResult: any, toolUse?: any): TemplateResult {
		return html`
			<div class="mb-4">
				<div
					class="text-vs-muted px-4 pb-0 cursor-pointer hover:text-white transition-colors"
					@click=${this.toggleContent}
				>
					<span class="mr-2">[+]</span>
					Tool Result ${toolResult?.is_error ? "❌" : "✅"}
				</div>
				<div class="bg-vs-bg-secondary mx-4 p-4 text-vs-text hidden overflow-x-auto">
					<pre class="whitespace-pre overflow-x-auto" style="white-space: pre; font-family: monospace;">
${typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content, null, 2)}</pre
					>
				</div>
				${toolUse
					? html`
							<div>
								<div
									class="text-vs-muted px-4 cursor-pointer hover:text-white transition-colors"
									@click=${this.toggleContent}
								>
									<span class="mr-2">[+]</span>
									Raw Tool Call
								</div>
								<div class="bg-vs-bg-secondary mx-4 p-4 text-vs-text hidden">
									${this.wrapInScrollable(JSON.stringify(toolUse, null, 2))}
								</div>
							</div>
						`
					: ""}
			</div>
		`;
	}

	/** Standard layout wrapper for a tool header, body, and optional result. */
	protected renderToolContainer(
		toolUse: any,
		toolResult?: any,
		options: {
			isCollapsible?: boolean;
			isCollapsed?: boolean;
			isClickToExpand?: boolean;
			customContent?: TemplateResult;
		} = {},
	): TemplateResult {
		const { isCollapsible = false, isCollapsed = false, isClickToExpand = false, customContent } = options;

		const contentDiv = customContent || html`${this.renderToolUseContent(toolUse)}`;
		const headerClasses = isClickToExpand
			? "text-vs-type px-4 break-all cursor-pointer hover:text-white transition-colors"
			: "text-vs-type px-4 break-all";
		const contentClasses = isCollapsed
			? "bg-vs-bg-secondary mx-4 p-4 text-vs-text hidden"
			: "bg-vs-bg-secondary mx-4 p-4 text-vs-text";

		return html`
			<div class="mt-4 mb-4">
				<div class="${headerClasses}" @click=${isClickToExpand ? this.toggleContent : undefined}>
					${isCollapsible ? html`<span class="mr-2">[${isCollapsed ? "+" : "-"}]</span>` : ""}
					${this.getToolDisplayName(toolUse)}
				</div>
				<div class="${contentClasses}">${contentDiv}</div>
				${toolResult ? this.renderToolResult(toolResult, toolUse) : ""}
			</div>
		`;
	}

	/** Shows the first 10 lines of Write tool content with an expand hint. */
	protected renderWritePreview(toolUse: any): TemplateResult {
		const input = toolUse.input;
		if (!input?.content) {
			return html`<div class="text-vs-muted">No content</div>`;
		}

		const content = input.content;
		const lines = content.split("\n");
		const preview = lines.slice(0, 10);
		const hasMore = lines.length > 10;

		return html`
			${this.wrapInScrollable(preview.join("\n"))}
			${hasMore ? html`<div class="text-vs-muted">... ${lines.length - 10} more lines (click to expand)</div>` : ""}
		`;
	}

	/** Renders a line-based diff between old and new strings for Edit/MultiEdit tools. */
	protected renderDiff(oldStr: string, newStr: string): TemplateResult[] {
		const diff = Diff.diffLines(oldStr, newStr);
		const diffLines = [];

		for (const part of diff) {
			const lines = part.value.split("\n");
			// Remove empty last line from split if it exists
			if (lines[lines.length - 1] === "") {
				lines.pop();
			}

			for (const line of lines) {
				if (part.added) {
					diffLines.push(html`<div class="bg-green-600/20"><pre class="text-vs-text m-0">+ ${line}</pre></div>`);
				} else if (part.removed) {
					diffLines.push(html`<div class="bg-red-600/20"><pre class="text-vs-text m-0">- ${line}</pre></div>`);
				} else {
					diffLines.push(html`<div><pre class="text-vs-text m-0">  ${line}</pre></div>`);
				}
			}
		}

		return diffLines;
	}

	/** Formats a token count for compact header display (e.g. 42k, 1.2M). */
	protected renderTools(tools: ToolUnion[]): TemplateResult {
		return html`
			${tools.map((tool) => {
				if ("name" in tool && tool.name) {
					const description = ("description" in tool && tool.description) || "No description";

					return this.renderCollapsibleSection(
						tool.name,
						html`
							<div class="text-vs-text ml-4 mb-3 markdown-content">
								${unsafeHTML(markdownToHtml(description))}
							</div>

							${"input_schema" in tool && tool.input_schema && typeof tool.input_schema === "object"
								? (() => {
										const schema = tool.input_schema as any;
										if (schema.properties) {
											return html`
												<div class="text-vs-muted mb-2">Parameters:</div>
												${Object.entries(schema.properties).map(([paramName, paramDef]) => {
													const def = paramDef as any;
													const required = schema.required?.includes(paramName) ? " (required)" : "";
													const type = def.type ? ` [${def.type}]` : "";
													const desc = def.description ? ` - ${def.description}` : "";
													return html`
														<div class="ml-4 mb-1">
															<span class="text-vs-user">${paramName}</span>
															<span class="text-vs-muted">${type}${required}${desc}</span>
														</div>
													`;
												})}
											`;
										}
										return html``;
									})()
								: html``}
						`,
						{
							titleClasses: "text-vs-type font-bold",
							containerClasses: "mb-4",
							isExpanded: true,
						},
					);
				}
				return html`<pre class="mb-4">${JSON.stringify(tool, null, 2)}</pre>`;
			})}
		`;
	}

}
