'use strict';
// How a test marks a known app bug.
//
// A test that demonstrates a bug asserts what the app SHOULD do, inside
// knownBug(). The test is reported as an expected failure only when that
// assertion fails in the way the bug is known to fail (`bug.shows`). Anything
// else is a real failure:
//   - set-up that breaks before knownBug() is reached;
//   - the assertion failing for another reason (a broken harness, a new bug);
//   - the assertion passing, which means the bug is gone and the wrapper must
//     be removed.
//
// E2E_SHOW_BUGS=1 leaves the expected-failure mark out, so every known bug
// shows up as an ordinary failure with its message, screenshots and traces.

const { test } = require('@playwright/test');
const { stripVTControlCharacters } = require('node:util');

const SHOW = process.env.E2E_SHOW_BUGS === '1';

const plain = (s) => stripVTControlCharacters(String(s || ''));

/**
 * Run `assertCorrect`, which asserts the correct behaviour, as the last thing
 * in a test.
 *
 *   bug.id      short name, also used in e2e/BUGS.md
 *   bug.title   one sentence
 *   bug.where   app file:line
 *   bug.shows   RegExp that the failure message must match for the failure to
 *               count as this bug. Hard and soft (expect.soft) failures count.
 *   when        false: no bug expected here (another engine, a wider screen);
 *               the assertion simply has to pass.
 */
async function knownBug(table, bug, assertCorrect, { when = true } = {}) {
  if (!when) {
    await assertCorrect();
    return;
  }
  if (!(bug.shows instanceof RegExp)) throw new Error(`knownBug(${bug.id}): bug.shows must be a RegExp matching the failure this bug causes`);
  const info = table.testInfo;
  const text = `${bug.title} [${bug.where}]`;
  info.annotations.push({ type: 'known bug', description: `${bug.id}: ${text}` });

  const before = info.errors.length;
  let thrown = null;
  try {
    await test.step(`KNOWN BUG ${bug.id}: asserting the correct behaviour`, assertCorrect);
  } catch (err) {
    thrown = err;
  }
  const failures = [
    ...info.errors.slice(before).map((e) => plain(e.message || e.value)),
    ...(thrown ? [plain(thrown.message || thrown)] : []),
  ].filter(Boolean);

  if (!failures.length) {
    throw new Error(
      `KNOWN BUG ${bug.id} did not show: the app behaved correctly in this test.\n  ${text}\n` +
      'If it has been fixed, take the knownBug() wrapper off this test and move the entry in e2e/BUGS.md.',
    );
  }
  if (!failures.some((f) => bug.shows.test(f))) {
    throw new Error(
      `This test failed, but not in the way known bug ${bug.id} fails (no failure matches ${bug.shows}). ` +
      `It is NOT counted as an expected failure.\n\n${failures.join('\n\n')}`,
    );
  }
  // An expected failure must not swallow anything else. A JS error, a failed
  // request or an HTTP error that the test did not declare is a finding of its
  // own, so it fails the test for real. (Without this the fixture's teardown
  // check would only add one more error to a test that is "expected to fail".)
  const stray = table.unexpectedErrors();
  if (stray.length) {
    throw new Error(
      `Known bug ${bug.id} showed, but the phones also recorded ${stray.length} problem(s) this test does not declare with ` +
      'table.expectError()/allowError(). It is NOT counted as an expected failure.\n' +
      stray.map((e) => `  [${e.kind}] ${e.phone}: ${e.text}`).join('\n'),
    );
  }
  if (!SHOW) test.fail(true, text);
  if (thrown) throw thrown;
}

module.exports = { knownBug, SHOW };
