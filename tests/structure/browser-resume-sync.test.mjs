import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const harness = fs.readFileSync(new URL('../browser/interrupted-resume.mjs', import.meta.url), 'utf8');

test('second receiver waits for rendered resume evidence before sampling it', () => {
  const helper = harness.match(/async function waitForResumedTransfer\(page(?:, timeout = \d[\d_]*)?\) \{([\s\S]*?)\n\}/);
  assert.ok(helper, 'resume harness must define a dedicated resumed-transfer synchronization helper');

  const body = helper[1];
  assert.match(body, /dataset\?\.state !== 'receiving'/, 'receiving state must remain necessary');
  assert.match(body, /data-progress-value/, 'helper must observe rendered progress');
  assert.match(body, /percent > 0/, 'helper must require a non-zero resume offset');
  assert.match(body, /data-status/, 'helper must observe rendered status');
  assert.match(body, /Resuming/i, 'helper must require explicit resumed status');
  assert.match(body, /timeout/, 'helper must keep a bounded wait');

  const receiver2Start = harness.indexOf('const receiver2 =');
  const completionWait = harness.indexOf("await waitForState(receiver2, 'done'", receiver2Start);
  assert.ok(receiver2Start >= 0 && completionWait > receiver2Start, 'second receiver flow must be discoverable');

  const receiver2Flow = harness.slice(receiver2Start, completionWait);
  const resumedWait = receiver2Flow.indexOf('await waitForResumedTransfer(receiver2');
  const progressSample = receiver2Flow.indexOf("receiver2.locator('[data-progress-value]')");
  assert.ok(resumedWait >= 0, 'second receiver must wait for observable resumed evidence');
  assert.ok(progressSample > resumedWait, 'resume evidence must be sampled only after resumed synchronization completes');
});

test('first receiver interrupts only after at least one durable OPFS checkpoint', () => {
  assert.match(
    harness,
    /OPFS_DURABILITY_CHECKPOINT_BYTES/,
    'browser harness must bind interruption timing to the production OPFS durability boundary',
  );
  assert.match(
    harness,
    /MIN_DURABLE_PERCENT/,
    'browser harness must derive an observable progress floor beyond the durability checkpoint',
  );

  const helper = harness.match(/async function waitForPartialProgress\(page, minPercent\) \{([\s\S]*?)\n\}/);
  assert.ok(helper, 'partial-progress helper must accept the durable progress floor');
  assert.match(helper[1], /percent >= minPercent/, 'interruption must not occur before the durable progress floor');

  const receiver1Start = harness.indexOf('const receiver1 =');
  const receiver1Close = harness.indexOf('await receiver1.close()', receiver1Start);
  assert.ok(receiver1Start >= 0 && receiver1Close > receiver1Start, 'first receiver interruption flow must be discoverable');
  const receiver1Flow = harness.slice(receiver1Start, receiver1Close);
  assert.match(
    receiver1Flow,
    /waitForPartialProgress\(receiver1, MIN_DURABLE_PERCENT\)/,
    'the live browser interruption must wait for a completed durability checkpoint',
  );
});
