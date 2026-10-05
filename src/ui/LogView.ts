// A dedicated tab showing live plugin logs for debugging.
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { logger } from "../log";

export const LOG_VIEW_TYPE = "duckuments-log-view";

export class LogView extends ItemView {
    private unsub: () => void = () => {};
    private pre: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return LOG_VIEW_TYPE;
    }
    getDisplayText(): string {
        return "Duckuments LiveSync logs";
    }
    getIcon(): string {
        return "scroll-text";
    }

    async onOpen(): Promise<void> {
        this.contentEl.empty();
        this.pre = this.contentEl.createEl("pre", { cls: "duckuments-log" });
        this.pre.setText(logger.lines.join("\n") + "\n");
        this.unsub = logger.subscribe((line) => {
            if (!this.pre) return;
            this.pre.appendText(line + "\n");
            this.pre.scrollTop = this.pre.scrollHeight;
        });
    }

    async onClose(): Promise<void> {
        this.unsub();
        this.pre = null;
    }
}
