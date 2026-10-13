'use strict';
// Runs once after all tests, while the server is still up. Fails the run if
// the race detector reported anything the suite does not already know about.

const server = require('./server');

module.exports = async function globalTeardown() {
  const { reports, unknown, known } = server.scanRaces();
  const bar = '='.repeat(72);
  if (known.length) {
    const byIssue = new Map();
    for (const k of known) byIssue.set(k.issue.id, [...(byIssue.get(k.issue.id) || []), k.text]);
    console.warn(`\n${bar}\n[e2e] KNOWN DATA RACE(S) in the server (${known.length} report(s)). Not failing the run.`);
    for (const [id, texts] of byIssue) {
      const issue = known.find((k) => k.issue.id === id).issue;
      console.warn(`\n[e2e] ${id}: ${issue.title}\n[e2e]   ${issue.where}\n[e2e]   ${texts.length} report(s); first one:\n`);
      console.warn(texts[0].trim().split('\n').map((l) => `    ${l}`).join('\n'));
    }
    console.warn(`\n[e2e] Full log: ${server.LOG_PATH}\n[e2e] Run with E2E_STRICT_RACES=1 (or E2E_STRICT=1) to fail on these.\n${bar}\n`);
  }
  if (unknown.length) {
    const body = unknown.map((r, i) => `--- report ${i + 1} of ${unknown.length} ---\n${r.trim()}`).join('\n\n');
    throw new Error(
      `The Go race detector reported ${unknown.length} DATA RACE(S) in the server during this run ` +
      `(${reports.length} report(s) in total).\nServer log: ${server.LOG_PATH}\n\n${body}\n`,
    );
  }
};
