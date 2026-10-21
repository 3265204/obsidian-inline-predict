import { vi } from 'vitest';
import { installObsidianDomHelpers } from './helpers/dom';

if (typeof document !== 'undefined') {
	installObsidianDomHelpers(document);
	vi.stubGlobal('createFragment', () => document.createDocumentFragment());
}
