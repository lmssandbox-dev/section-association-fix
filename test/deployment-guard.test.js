const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deploymentGuard } = require('../src/shared/deploymentGuard');

function launch(expected, token, req = {}) {
  const result = { apiCalls: 0 };
  const res = {
    status(code) { result.status = code; return this; },
    send(body) { result.body = body; return this; }
  };
  if (deploymentGuard(expected)(token, req, res)) result.apiCalls++;
  return result;
}

test('matching verified deployment may continue', () => {
  assert.deepEqual(launch(' deployment-1 ', { deploymentId: 'deployment-1' }), { apiCalls: 1 });
});

test('missing configuration blocks launches without preventing server setup', () => {
  for (const expected of [undefined, '', '  ']) {
    const result = launch(expected, { deploymentId: 'deployment-1' });
    assert.equal(result.status, 503);
    assert.equal(result.apiCalls, 0);
  }
});

test('missing, wrong and spoofed deployment IDs cannot reach API work', () => {
  for (const token of [undefined, {}, { deploymentId: 'other' }, { deploymentId: 1 }, { deploymentId: 'deployment-1 ' }]) {
    const result = launch('deployment-1', token, {
      body: { deploymentId: 'deployment-1' }, query: { deploymentId: 'deployment-1' }
    });
    assert.equal(result.status, 403);
    assert.equal(result.apiCalls, 0);
  }
});
