'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../scripts/write-activity');
const dates = ['2027-01-01T00:00:00Z','2027-01-02T00:00:00Z','2027-01-03T00:00:00Z'];
for (const type of ['assignment','quiz','discussionTopic']) {
  test(`CLI ${type} defaults to preview and requires explicit apply`, () => {
    const args = [type,'9524','11',...dates,...(type === 'discussionTopic' ? ['617'] : [])];
    const preview = parseArgs(args);
    assert.equal(preview.dryRun,true);
    assert.equal(preview.activity.type,type);
    assert.equal(preview.activity.parentId,type === 'discussionTopic' ? '617' : undefined);
    assert.deepEqual(parseArgs([...args,'--apply']), {...preview,dryRun:false});
    assert.throws(() => parseArgs([...args,'--unknown']));
  });
}
test('CLI rejects missing forum, extraneous forum, unsupported type and invalid dates', () => {
  for (const args of [ ['discussionTopic','9524','11',...dates], ['quiz','9524','11',...dates,'617'],
    ['contentTopic','9524','11',...dates], ['assignment','9524','11','bad',...dates.slice(1)] ]) {
    assert.throws(() => parseArgs(args));
  }
});
