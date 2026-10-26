/** @file Left-hand table of contents for trace and train conversations. */
import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { contextAnchorId, conversationAnchorId, stepAnchorId, type ViewerConversation } from "../utils/viewer-model";

@customElement("conversation-sidebar-view")
export class ConversationSidebarView extends LitElement {
	@property({ attribute: false }) conversations: ViewerConversation[] = [];
	@property({ attribute: false }) selectionLabels: string[] = [];
	@property() selectionKind: "conversation" | "trajectory" = "conversation";
	@property({ type: Number }) selectedIndex = 0;
	@state() private open = false;

	createRenderRoot() { return this; }

	private jump(anchorId: string) {
		this.open = false;
		this.dispatchEvent(new CustomEvent("navigation-jump", { detail: anchorId, bubbles: true }));
	}

	private selectEntry(index: number) {
		this.open = false;
		this.dispatchEvent(new CustomEvent("collection-select", { detail: index, bubbles: true }));
	}

	render() {
		return html`
			<button class="trace-sidebar-toggle" type="button" aria-label="Open conversation outline"
				aria-expanded=${this.open ? "true" : "false"} @click=${() => this.open = !this.open}>☰ Outline</button>
			${this.open ? html`<div class="trace-sidebar-backdrop" @click=${() => this.open = false}></div>` : ""}
			<aside class=${`trace-sidebar ${this.open ? "trace-sidebar-open" : ""}`} aria-label="Conversation outline">
				<div class="trace-sidebar-heading">Outline
					<button class="trace-sidebar-close" type="button" aria-label="Close outline" @click=${() => this.open = false}>×</button>
				</div>
				${this.selectionLabels.length ? html`
					<div class="trace-sidebar-section-label">${this.selectionKind === "trajectory" ? "Trajectories" : "Conversations"}</div>
					<div class="trace-sidebar-collections">${this.selectionLabels.map((label, index) => html`
						<button type="button" class=${`trace-sidebar-link ${index === this.selectedIndex ? "trace-sidebar-selected" : ""}`}
							aria-current=${index === this.selectedIndex ? "true" : "false"}
							title=${label} @click=${() => this.selectEntry(index)}>
							${this.selectionKind === "trajectory" ? "Trajectory" : "Conversation"} ${index + 1}</button>`)}</div>
				` : ""}
				<nav aria-label="Conversation sections">${this.conversations.map((conversation, index) => html`
					<div class="trace-sidebar-group">
						<button type="button" class="trace-sidebar-link trace-sidebar-conversation" title=${conversation.title}
							@click=${() => this.jump(conversationAnchorId(conversation.id))}>
							${this.conversations.length > 1 ? `Conversation ${index + 1}` : "Conversation"}</button>
						${conversation.context.map((context, contextIndex) => html`
							<button type="button" class="trace-sidebar-link trace-sidebar-child" title=${context.label}
								@click=${() => this.jump(contextAnchorId(conversation.id, contextIndex))}>${context.label}</button>`)}
						${conversation.steps.map((step) => html`
							<button type="button" class="trace-sidebar-link trace-sidebar-child trace-sidebar-step" title=${step.meta}
								aria-label=${`Step ${step.number}${step.trainable ? ", trainable" : ""}`}
								@click=${() => this.jump(stepAnchorId(step.id))}>
								<span>Step ${step.number}</span>${step.trainable ? html`<span class="trace-sidebar-trainable">TRAINABLE</span>` : ""}
							</button>`)}
					</div>`)}</nav>
			</aside>`;
	}
}
