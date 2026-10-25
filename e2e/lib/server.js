'use strict';
// Where the server under test lives, and how to read what it printed.
//
// The server is the real Go binary, built with the race detector and started
// by Playwright's `webServer` (see playwright.config.js). Its stdout and stderr
// go to a log file so a `DATA RACE` report can be found after the run.

const fs = require('node:fs');
const path = require('node:path');

const E2E_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(E2E_DIR, '..');

const DEFAULT_PORT = 8791;
const PORT = Number(process.env.E2E_PORT || DEFAULT_PORT);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT === 8080) {
  throw new Error(`E2E_PORT must be a port number other than 8080, got "${process.env.E2E_PORT}"`);
}
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const HEALTH_URL = `${BASE_URL}/api/health`;

// Several suites may run at once on different ports, so everything a run writes
// is keyed by port. Playwright empties OUTPUT_DIR at the start of a run; the
// server log and binary live beside it, not inside it.
const RESULTS_DIR = path.join(E2E_DIR, 'test-results');
const OUTPUT_DIR = path.join(RESULTS_DIR, `port-${PORT}`);
const SERVER_DIR = path.join(RESULTS_DIR, 'server');
const LOG_PATH = path.join(SERVER_DIR, `server-${PORT}.log`);
const BIN_PATH = path.join(SERVER_DIR, `codenames-pictures-${PORT}`);
const REPORT_DIR = path.join(E2E_DIR, PORT === DEFAULT_PORT ? 'playwright-report' : `playwright-report-${PORT}`);

// The go command: E2E_GO if set, else the standard install location if it is
// there (it is often not on the PATH of a shell started by a tool), else `go`.
const GO = process.env.E2E_GO || (fs.existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : 'go');

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Shell command for `webServer.command`; run with cwd = REPO_ROOT. */
function serverCommand() {
  // Build first, then exec the binary, so the process Playwright stops is the
  // server itself (with `go run` it would be the go tool, and the server could
  // outlive the run). GORACE keeps the server alive after a report so the rest
  // of the suite still runs; the report is found in the log at teardown.
  return [
    `mkdir -p ${sh(SERVER_DIR)}`,
    `${sh(GO)} build -race -o ${sh(BIN_PATH)} . > ${sh(LOG_PATH)} 2>&1`,
    `GORACE="halt_on_error=0" exec ${sh(BIN_PATH)} -addr ${HOST}:${PORT} >> ${sh(LOG_PATH)} 2>&1`,
  ].join(' && ');
}

function readLog() {
  try { return fs.readFileSync(LOG_PATH, 'utf8'); } catch { return ''; }
}

function logSize() {
  try { return fs.statSync(LOG_PATH).size; } catch { return 0; }
}

/** Text the server wrote after byte offset `from`. */
function readLogFrom(from) {
  try {
    const buf = fs.readFileSync(LOG_PATH);
    return buf.subarray(Math.min(from, buf.length)).toString('utf8');
  } catch { return ''; }
}

const RACE_MARK = 'WARNING: DATA RACE';
const RACE_RULE = '==================';

/**
 * Split the Go race detector's output into individual reports. Each report is
 * the text between two `==================` rules and starts with
 * "WARNING: DATA RACE".
 */
function raceReports(text) {
  const reports = [];
  const lines = String(text).split('\n');
  let cur = null;
  for (const line of lines) {
    if (line.trim() === RACE_RULE) {
      if (cur && cur.some((l) => l.includes('DATA RACE'))) reports.push(cur.join('\n'));
      cur = [];
      continue;
    }
    if (cur) cur.push(line);
  }
  // A report cut off mid-write (server killed) still counts.
  if (cur && cur.some((l) => l.includes('DATA RACE'))) reports.push(cur.join('\n'));
  // "DATA RACE" outside any rule pair: keep the whole text so nothing is lost.
  if (!reports.length && String(text).includes('DATA RACE')) reports.push(String(text));
  return reports;
}

/**
 * Races the suite already knows about. A report matching one of these is
 * printed loudly but does not fail the run, so the suite can stay green while
 * the bug is open. Everything else fails the run. Set E2E_STRICT_RACES=1 (or E2E_STRICT=1) to
 * fail on known races too (use it to check whether a fix landed).
 *
 * Keep each entry narrow: `all` lists substrings that must ALL appear in the
 * report.
 */
const KNOWN_RACES = [
  {
    id: 'race-clue-log',
    title: 'the clue log is marshalled outside the room lock while Guess appends to it',
    where: 'room.go View() hands out `Log: g.Log` (shared backing array); main.go handleEvents/handleAction ' +
      'json-encode the view after the lock is released; game.go Guess() writes g.Log[n-1].Guesses under the lock',
    // Both halves must be in the report: the write in Guess and a JSON encoder read.
    all: ['(*Game).Guess()', 'encoding/json.'],
  },
];

function classifyRace(report) {
  if (process.env.E2E_STRICT_RACES === '1' || process.env.E2E_STRICT === '1') return null;
  return KNOWN_RACES.find((k) => k.all.every((s) => report.includes(s))) || null;
}

/** Scan server output. Returns { reports, unknown: [text], known: [{issue, text}] }. */
function scanRaces(text = readLog()) {
  const reports = raceReports(text);
  const unknown = [];
  const known = [];
  for (const r of reports) {
    const issue = classifyRace(r);
    if (issue) known.push({ issue, text: r }); else unknown.push(r);
  }
  return { reports, unknown, known };
}

module.exports = {
  E2E_DIR, REPO_ROOT, DEFAULT_PORT, PORT, HOST, BASE_URL, HEALTH_URL,
  RESULTS_DIR, OUTPUT_DIR, SERVER_DIR, LOG_PATH, BIN_PATH, REPORT_DIR,
  serverCommand, readLog, readLogFrom, logSize,
  RACE_MARK, raceReports, scanRaces, classifyRace, KNOWN_RACES,
};
