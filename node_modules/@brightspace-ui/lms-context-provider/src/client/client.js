import { tryGet as tryGetImpl, tryPerform as tryPerformImpl } from './client-internal.js';

export async function tryGet(contextType, options, onChangeCallback) {
	return await tryGetImpl(contextType, options, onChangeCallback);
}

export async function tryPerform(actionType, options) {
	await tryPerformImpl(actionType, options);
}
