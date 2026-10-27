/** @file Shared trace/train conversation, context, step and JSON rendering. */
import { html, TemplateResult, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { MessageContentBase } from "./message-content-base";
import { contextAnchorId, conversationAnchorId, stepAnchorId, type ViewerContext, type ViewerConversation, type ViewerItem, type ViewerStep } from "../utils/viewer-model";

const STEP_PAGE_SIZE = 10;

/** Renders the same conversation layout for captured traces and training exports. */
@customElement("conversation-view")
export class ConversationView extends MessageContentBase {
	@property({ attribute: false }) conversations: ViewerConversation[] = [];
	@state() private page = 0;

	createRenderRoot() { return this; }

	protected willUpdate(changed: PropertyValues<this>) {
		if (!changed.has("conversations")) return;
		const previous = changed.get("conversations") as ViewerConversation[] | undefined;
		const current = this.conversations[0];
		if (previous?.[0]?.id !== current?.id) this.page = 0;
		else if (current) this.page = Math.min(this.page, Math.max(0, Math.ceil(current.steps.length / STEP_PAGE_SIZE) - 1));
	}

	/** Make a sidebar Step visible before the app scrolls to its anchor. */
	async revealStep(anchorId: string): Promise<void> {
		const index = this.conversations[0]?.steps.findIndex((step) => stepAnchorId(step.id) === anchorId) ?? -1;
		if (index < 0) return;
		this.page = Math.floor(index / STEP_PAGE_SIZE);
		await this.updateComplete;
	}

	private changePage(next: number, total: number) {
		this.page = Math.max(0, Math.min(next, Math.ceil(total / STEP_PAGE_SIZE) - 1));
		void this.updateComplete.then(() => {
			this.querySelector<HTMLElement>(".trace-step-pagination-top")?.scrollIntoView({ block: "start" });
		});
	}

	private renderPagination(total: number, page: number, position: "top" | "bottom"): TemplateResult {
		const count = Math.ceil(total / STEP_PAGE_SIZE);
		if (count <= 1) return html``;
		const first = page * STEP_PAGE_SIZE + 1;
		const last = Math.min(total, (page + 1) * STEP_PAGE_SIZE);
		return html`<nav class=${`trace-step-pagination trace-step-pagination-${position}`} aria-label="Step pages">
			<button type="button" ?disabled=${page === 0} @click=${() => this.changePage(page - 1, total)}>Previous</button>
			<span>Steps ${first}–${last} of ${total}</span>
			<select aria-label="Select Step page" @change=${(event: Event) => this.changePage(Number((event.currentTarget as HTMLSelectElement).value), total)}>
				${Array.from({ length: count }, (_, index) => html`<option value=${index} ?selected=${index === page}>Page ${index + 1} / ${count}</option>`)}
			</select>
			<button type="button" ?disabled=${page >= count - 1} @click=${() => this.changePage(page + 1, total)}>Next</button>
		</nav>`;
	}

	private renderContext(context: ViewerContext): TemplateResult {
		if (context.kind === "tools") {
			return this.renderCollapsibleSection(context.label, html`
				<div class="trace-block-body">${this.renderTools(context.tools)}</div>
				${this.renderRawJson(context.label.toLowerCase(), context.raw)}
			`, { titleClasses: "trace-block-header text-vs-type", containerClasses: "trace-context-section trace-block trace-message-tool", count: context.tools.length });
		}
		const content = context.kind === "system"
			? html`<div class="trace-block-body markdown-content">${unsafeHTML(this.formatSystem(context.system))}</div>`
			: html`<div class="trace-block-body markdown-content">${this.formatContent(context.content, undefined, false)}</div>`;
		return this.renderCollapsibleSection(context.label, html`${content}${this.renderRawJson(context.label.toLowerCase(), context.raw)}`,
			{ titleClasses: "trace-block-header text-vs-function", containerClasses: "trace-context-section trace-block trace-message-system" });
	}

	private renderItem(item: ViewerItem): TemplateResult {
		const content = item.kind === "response"
			? this.formatResponseContent(item.response)
			: this.formatContent(item.content, undefined, item.showContextBlocks !== false);
		return html`
			<div class=${`trace-block ${item.roleClass}`}>
				<div class="trace-block-header">${item.label}</div>
				<div class="trace-block-body">${content}</div>
			</div>
			${this.renderParsedJson(item.label, item.raw)}
		`;
	}

	private toggleStep(event: Event) {
		const header = event.currentTarget as HTMLElement;
		const content = header.nextElementSibling as HTMLElement;
		const toggle = header.querySelector(".trace-step-toggle") as HTMLElement;
		if (!content) return;
		const hidden = content.classList.toggle("hidden");
		if (toggle) toggle.textContent = hidden ? "[+]" : "[-]";
	}

	private renderStep(step: ViewerStep): TemplateResult {
		return html`
			<section id=${stepAnchorId(step.id)} class="trace-step-card">
				<div class="trace-step-header" @click=${this.toggleStep}>
					<span><span class="trace-step-toggle mr-2">[-]</span><span class="trace-step-title">Step ${step.number}</span>
						${step.trainable ? html`<span class="train-step-badge">TRAINABLE</span>` : ""}</span>
					<span class="trace-step-meta">${step.meta}</span>
				</div>
				<div class="trace-step-content">${step.items.map((item) => this.renderItem(item))}</div>
			</section>
		`;
	}

	private renderConversation(conversation: ViewerConversation): TemplateResult {
		const page = Math.min(this.page, Math.max(0, Math.ceil(conversation.steps.length / STEP_PAGE_SIZE) - 1));
		const visibleSteps = conversation.steps.slice(page * STEP_PAGE_SIZE, (page + 1) * STEP_PAGE_SIZE);
		const content = html`
			<div id=${conversationAnchorId(conversation.id)} class="trace-conversation-anchor border ${conversation.compacted ? "border-red-700" : "border-vs-highlight"} p-4 mb-0">
				<div class=${conversation.compacted ? "text-red-400" : "text-vs-assistant"}>${conversation.title}</div>
				<div class="text-vs-muted train-source">${conversation.subtitle}</div>
			</div>
			<div class="trace-context-root">${conversation.context.map((context, index) => html`
				<div id=${contextAnchorId(conversation.id, index)} class="trace-context-anchor">${this.renderContext(context)}</div>`)}</div>
			${this.renderPagination(conversation.steps.length, page, "top")}
			${visibleSteps.map((step) => this.renderStep(step))}
			${this.renderPagination(conversation.steps.length, page, "bottom")}
		`;
		return html`<div class="mt-8 first:mt-0">
			${conversation.compacted ? html`
				<div class="cursor-pointer text-red-400 hover:text-red-300 transition-colors border border-red-700 p-4"
					@click=${this.toggleContent}><span class="mr-2">[+]</span>Compacted (click to view details)</div>
				<div class="trace-compacted-content hidden mt-8">${content}</div>
			` : content}
		</div>`;
	}

	render() {
		return this.conversations.length
			? html`<div class="max-w-[60em] mx-auto">${this.conversations.map((conversation) => this.renderConversation(conversation))}</div>`
			: html`<div>No conversations found.</div>`;
	}
}
