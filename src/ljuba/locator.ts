/**
 * LjubaLocator wraps querySelectorAll results with a Playwright-compatible API.
 * Chainable methods for DOM queries inside the Studio OrbPreview container.
 */
export class LjubaLocator {
  protected container: HTMLElement;
  protected selector: string;

  constructor(container: HTMLElement, selector: string) {
    this.container = container;
    this.selector = selector;
  }

  protected getElements(): NodeListOf<Element> {
    return this.container.querySelectorAll(this.selector);
  }

  protected getFirst(): Element | null {
    return this.container.querySelector(this.selector);
  }

  first(): LjubaLocator {
    const el = this.getFirst();
    if (!el) return this;
    return new LjubaElementLocator(el as HTMLElement);
  }

  nth(index: number): LjubaLocator {
    const elements = this.getElements();
    const el = elements[index];
    if (!el) return new LjubaElementLocator(document.createElement('div'));
    return new LjubaElementLocator(el as HTMLElement);
  }

  filter(options: { hasText?: string }): LjubaLocator {
    if (!options.hasText) return this;
    return new LjubaFilteredLocator(this.container, this.selector, options.hasText);
  }

  async count(): Promise<number> {
    return this.getElements().length;
  }

  async click(): Promise<void> {
    const el = this.getFirst() as HTMLElement | null;
    if (!el) throw new Error(`No element found for selector: ${this.selector}`);
    el.click();
    await new Promise<void>(r => setTimeout(r, 300));
  }

  async fill(value: string): Promise<void> {
    const el = this.getFirst() as HTMLInputElement | null;
    if (!el) throw new Error(`No element found for selector: ${this.selector}`);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async getAttribute(name: string): Promise<string | null> {
    const el = this.getFirst();
    return el?.getAttribute(name) ?? null;
  }

  async textContent(): Promise<string | null> {
    const el = this.getFirst();
    return el?.textContent ?? null;
  }

  async allTextContents(): Promise<string[]> {
    const elements = this.getElements();
    return Array.from(elements).map(el => el.textContent ?? '');
  }

  async isVisible(options?: { timeout?: number }): Promise<boolean> {
    const timeout = options?.timeout ?? 0;
    if (timeout > 0) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (this.getFirst()) return true;
        await new Promise<void>(r => setTimeout(r, 50));
      }
      return false;
    }
    return this.getFirst() !== null;
  }

  async selectOption(value: string): Promise<void> {
    const el = this.getFirst() as HTMLSelectElement | null;
    if (!el) throw new Error(`No select element found for: ${this.selector}`);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async hover(): Promise<void> {
    const el = this.getFirst() as HTMLElement | null;
    if (el) el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  }

  async press(key: string): Promise<void> {
    const el = this.getFirst() as HTMLElement | null;
    if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }

  async isEditable(): Promise<boolean> {
    const el = this.getFirst() as HTMLInputElement | null;
    return el ? !el.disabled && !el.readOnly : false;
  }

  async isEnabled(): Promise<boolean> {
    const el = this.getFirst() as (HTMLButtonElement | HTMLInputElement) | null;
    return el ? !el.disabled : false;
  }
}

/**
 * Locator that wraps a specific resolved element (for first/nth).
 */
class LjubaElementLocator extends LjubaLocator {
  private element: HTMLElement;

  constructor(element: HTMLElement) {
    super(element, '*');
    this.element = element;
  }

  async count(): Promise<number> {
    return 1;
  }

  async click(): Promise<void> {
    this.element.click();
    await new Promise<void>(r => setTimeout(r, 300));
  }

  async fill(value: string): Promise<void> {
    if (!(this.element instanceof HTMLInputElement) && !(this.element instanceof HTMLTextAreaElement)) {
      throw new Error(`Cannot fill non-input element: ${this.element.tagName}`);
    }
    this.element.value = value;
    this.element.dispatchEvent(new Event('input', { bubbles: true }));
    this.element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.element.getAttribute(name);
  }

  async textContent(): Promise<string | null> {
    return this.element.textContent;
  }

  async isVisible(): Promise<boolean> {
    return true;
  }

  first(): LjubaLocator {
    return this;
  }

  nth(): LjubaLocator {
    return this;
  }
}

/**
 * Locator that filters matched elements by text content.
 */
class LjubaFilteredLocator extends LjubaLocator {
  private filterText: string;

  constructor(container: HTMLElement, selector: string, filterText: string) {
    super(container, selector);
    this.filterText = filterText;
  }

  private getFilteredElements(): Element[] {
    const elements = this.container.querySelectorAll(this.selector);
    return Array.from(elements).filter(el => el.textContent?.includes(this.filterText));
  }

  async count(): Promise<number> {
    return this.getFilteredElements().length;
  }

  protected getFirst(): Element | null {
    const filtered = this.getFilteredElements();
    return filtered[0] ?? null;
  }

  protected getElements(): NodeListOf<Element> {
    // Return the filtered set as a fake NodeList-like via querySelectorAll on a wrapper
    // For simplicity, override methods that use getElements instead
    return this.container.querySelectorAll(this.selector);
  }

  async allTextContents(): Promise<string[]> {
    return this.getFilteredElements().map(el => el.textContent ?? '');
  }
}
