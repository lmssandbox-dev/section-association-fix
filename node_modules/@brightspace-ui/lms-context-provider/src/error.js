export class LmsContextProviderError extends Error {
	constructor(message) {
		super(`lms-context-provider: ${message}`);
		this.name = 'LmsContextProviderError';
	}
}
