import { allowFrame, initialize, registerPlugin, reset } from '../host/host-internal.js';

console.warn('Using lms-context-provider test host, this is intended for demo pages and tests only');

const contextMap = new Map();
const subscriptions = new Map();

export function addContext(name, newContext) {
	initialize();

	contextMap.set(name, newContext);

	const getContext = () => contextMap.get(name);
	const subscribe = (onChange, options) => {
		const context = contextMap.get(name);

		if (options?.sendImmediate) {
			onChange(context);
		}

		if (!subscriptions.has(name)) subscriptions.set(name, []);
		subscriptions.get(name).push(onChange);
	};

	registerPlugin(
		name,
		getContext,
		subscribe
	);
}

export function addFrame(frame, origin) {
	initialize();
	allowFrame(frame, origin);
}

export function modifyContext(name, newContext) {
	if (contextMap.has(name)) contextMap.set(name, newContext);
	subscriptions.get(name)?.forEach(callback => callback(newContext));
}

export function clear() {
	contextMap.clear();
	subscriptions.clear();
	reset();
}

