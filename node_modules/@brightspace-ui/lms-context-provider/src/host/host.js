import { allowFrame as allowFrameImpl, initialize as initializeImpl, registerPlugin as registerPluginImpl } from './host-internal.js';

export function initialize() {
	initializeImpl();
}

export function allowFrame(frame, origin) {
	allowFrameImpl(frame, origin);
}

export function registerPlugin(name, tryGetCallback, subscriptionCallback) {
	registerPluginImpl(name, tryGetCallback, subscriptionCallback);
}
