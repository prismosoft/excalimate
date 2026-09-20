import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePromiseOutcome } from '../dist/promise-outcome.js';

test('capturePromiseOutcome returns fulfilled values', async () => {
  assert.deepEqual(await capturePromiseOutcome(Promise.resolve('download')), {
    ok: true,
    value: 'download',
  });
});

test('capturePromiseOutcome immediately handles rejection', async () => {
  let unhandled = false;
  const listener = () => {
    unhandled = true;
  };
  process.on('unhandledRejection', listener);

  try {
    const event = capturePromiseOutcome(
      Promise.reject(new Error('browser context closed')),
    );
    await Promise.resolve();

    const outcome = await event;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /browser context closed/);
    assert.equal(unhandled, false);
  } finally {
    process.off('unhandledRejection', listener);
  }
});
