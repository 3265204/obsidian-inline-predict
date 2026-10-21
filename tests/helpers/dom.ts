/** jsdom 不加载 Obsidian；只补齐本插件实际使用的 DOM 帮助方法。 */
export function installObsidianDomHelpers(doc: Document): void {
	const owner = doc.defaultView;
	if (owner === null) return;
	const prototype: Node = owner.Node.prototype;
	function createElement<K extends keyof HTMLElementTagNameMap>(
		this: Node, tag: K, options: DomElementInfo | string = {},
	): HTMLElementTagNameMap[K] {
		const element = (this.ownerDocument ?? doc).createElement(tag);
		const info = typeof options === 'string' ? { cls: options } : options;
		if (info.cls) element.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
		if (typeof info.text === 'string') element.textContent = info.text;
		for (const [key, value] of Object.entries(info.attr ?? {})) {
			if (value !== null) element.setAttribute(key, String(value));
		}
		this.appendChild(element);
		return element;
	}
	Object.assign(prototype, {
		createEl: createElement,
		createSpan(this: Node, options?: DomElementInfo) { return createElement.call(this, 'span', options); },
		createDiv(this: Node, options?: DomElementInfo) { return createElement.call(this, 'div', options); },
	});
	Object.assign(owner.HTMLElement.prototype, {
		empty(this: HTMLElement) { this.replaceChildren(); },
		addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
	});
}
