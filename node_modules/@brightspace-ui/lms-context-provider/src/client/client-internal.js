import { LmsContextProviderError } from '../error.js';

const messageTimeoutMs = 150;
let oneTimeMessageListenerInitialized = false;
let subscriptionListenerInitialized = false;
let framedPromise;

const oneTimeCallbacks = new Map();
const subscriptionCallbacks = new Map();

function handleOneTimeMessageResponse(e) {
	if (!e?.data?.isContextProvider || !e.data.type) return;

	const callbacks = oneTimeCallbacks.get(e.data.type);
	if (callbacks === undefined || callbacks.length === 0) return;

	callbacks.forEach(cb => cb(e.data.value));
	oneTimeCallbacks.set(e.data.type, []);
}

async function sendMessage(message) {
	if (!oneTimeMessageListenerInitialized) {
		window.addEventListener('message', handleOneTimeMessageResponse);
		oneTimeMessageListenerInitialized = true;
	}

	return await new Promise(resolve => {
		if (!oneTimeCallbacks.has(message.type)) {
			oneTimeCallbacks.set(message.type, []);
		}

		oneTimeCallbacks.get(message.type).push(resolve);
		window.parent.postMessage(message, '*');
	});
}

function handleSubscribedChangeResponseEvent(e) {
	handleSubscribedChangeResponse(e.detail);
}

function handleSubscribedChangeResponseMessage(e) {
	if (!e?.data?.isContextProvider) return;
	handleSubscribedChangeResponse(e.data);
}

function handleSubscribedChangeResponse(responseData) {
	if (!responseData?.changedValues || !responseData.type) return;
	const callbacks = subscriptionCallbacks.get(responseData.type);
	callbacks.forEach(cb => cb(responseData.changedValues));
}

async function sendEvent(type, options, subscribe) {
	const isframedVal = await isFramed();

	if (subscribe && !subscriptionListenerInitialized) {
		isframedVal
			? window.addEventListener('message', handleSubscribedChangeResponseMessage)
			: document.addEventListener('lms-context-change', handleSubscribedChangeResponseEvent);

		subscriptionListenerInitialized = true;
	}

	if (isframedVal) {
		const message = {
			isContextProvider: true,
			type,
			options,
			subscribe
		};

		return await Promise.race([
			sendMessage(message),
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new LmsContextProviderError('No response from host')),
					messageTimeoutMs
				)
			)
		]);
	} else {
		const event = new CustomEvent(
			'lms-context-request', {
				detail: { type, options, subscribe }
			}
		);

		document.dispatchEvent(event);
		return event.detail.handled
			? event.detail.value
			: Promise.reject(new LmsContextProviderError('No response from host'));
	}
}

export function isFramed() {
	if (framedPromise !== undefined) return framedPromise;

	try {
		if (window === window.parent) {
			framedPromise = Promise.resolve(false);
			return framedPromise;
		}
	} catch {
		framedPromise = Promise.resolve(false);
		return framedPromise;
	}

	framedPromise = Promise.race([
		sendMessage({ isContextProvider: true, type: 'framed-request' }),
		new Promise(resolve => setTimeout(() => resolve(false), messageTimeoutMs))
	]);

	return framedPromise;
}

export async function tryGet(contextType, options, onChangeCallback) {
	const subscribe = (typeof(onChangeCallback) === 'function') || false;

	// Send one-time request first to make sure it's responded to before any change listeners are registered.
	const value = await sendEvent(contextType, options, subscribe);

	if (subscribe) {
		if (!subscriptionCallbacks.has(contextType)) {
			subscriptionCallbacks.set(contextType, []);
		}
		subscriptionCallbacks.get(contextType).push(onChangeCallback);
	}

	return value;
}

export async function tryPerform(actionType, options) {
	await sendEvent(actionType, options, false);
}

export function reset() {
	window.removeEventListener('message', handleOneTimeMessageResponse);
	window.removeEventListener('message', handleSubscribedChangeResponseMessage);
	document.removeEventListener('lms-context-change', handleSubscribedChangeResponseEvent);

	oneTimeMessageListenerInitialized = false;
	subscriptionListenerInitialized = false;
	framedPromise = undefined;

	oneTimeCallbacks.clear();
	subscriptionCallbacks.clear();
}
