import { ButtonComponent, Modal } from 'obsidian';
import type { App } from 'obsidian';

export interface ConfirmModalOptions {
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
}

/**
 * Small confirmation modal built on the stable `Modal` API (available since Obsidian 0.9.7).
 * `ConfirmationModal` exists in newer app versions but not in our `minAppVersion`, so it is not
 * used here.
 */
export class ConfirmModal extends Modal {
	private readonly options: ConfirmModalOptions;

	constructor(app: App, options: ConfirmModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { title, message, confirmLabel, onConfirm } = this.options;
		this.setTitle(title);
		this.contentEl.createEl('p', { text: message });
		const row = this.contentEl.createDiv({ cls: 'predictive-modal-buttons' });
		const confirm = new ButtonComponent(row);
		confirm.setButtonText(confirmLabel);
		confirm.setDestructive();
		confirm.onClick(() => {
			this.close();
			onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
