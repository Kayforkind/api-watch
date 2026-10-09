import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWatch, checkBody, deriveContract, checkEndpoint } from './watch.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'watch.mjs');
// Async on purpose: a sync child would block this process's fixture server.
const cli = (args) =>
  run(process.execPath, [CLI, ...args], { encoding: 'utf8' }).then(
    (r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr }),
    (e) => ({ status: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }),
  );
const headers = (h = {}) => new Headers(h);

test('clean response yields no breaking findings', () => {
  const f = checkBody({ expect: { status: 200, fields: { id: 'number', email: 'string' } } }, 200, headers(), { id: 1, email: 'a@b.c' });
  assert.deepEqual(f, []);
});

test('missing field is breaking and suggests a same-typed rename', () => {
  const f = checkBody({ expect: { fields: { email: 'string' } } }, 200, headers(), { mail: 'a@b.c' });
  assert.equal(f[0].level, 'BREAKING');
  assert.match(f[0].message, /"mail" \(string\) may be the renamed "email"/);
});

test('changed type is breaking', () => {
  const f = checkBody({ expect: { fields: { id: 'number' } } }, 200, headers(), { id: '1' });
  assert.equal(f[0].level, 'BREAKING');
  assert.match(f[0].message, /is string, expected number/);
});

test('sunset within 60 days is breaking; later sunset is a warning', () => {
  const soon = new Date(Date.now() + 10 * 86400000).toUTCString();
  const later = new Date(Date.now() + 200 * 86400000).toUTCString();
  assert.equal(checkBody({ expect: {} }, 200, headers({ sunset: soon }), {})[0].level, 'BREAKING');
  assert.equal(checkBody({ expect: {} }, 200, headers({ sunset: later }), {})[0].level, 'WARNING');
});

test('array contracts check the first element and reject non-arrays', () => {
  const c = { expect: { array: true, fields: { id: 'number' } } };
  assert.deepEqual(checkBody(c, 200, headers(), [{ id: 7 }]), []);
  assert.equal(checkBody(c, 200, headers(), { id: 7 })[0].level, 'BREAKING');
});

test('deriveContract records top-level field types from an object', () => {
  const c = deriveContract('users', 'https://x', 200, { id: 1, tags: ['a'], meta: null, name: 'n' });
  assert.deepEqual(c.expect.fields, { id: 'number', tags: 'array', meta: 'null', name: 'string' });
  assert.equal(c.expect.array, undefined);
});

test('deriveContract on an array uses its first element and marks it as an array', () => {
  const c = deriveContract('list', 'https://x', 200, [{ id: 1 }]);
  assert.equal(c.expect.array, true);
  assert.deepEqual(c.expect.fields, { id: 'number' });
});

let server;
let base;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 1, email: 'a@b.c', extra: true }));
    }
    if (req.url === '/renamed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 1, mail: 'a@b.c' }));
    }
    if (req.url === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html></html>');
    }
    if (req.url === '/slow') {
      return; // never respond
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('runWatch reports status, rename hints, and counts across endpoints', async () => {
  const report = await runWatch([
    { name: 'ok', url: base + '/ok', expect: { status: 200, fields: { id: 'number', email: 'string' } } },
    { name: 'renamed', url: base + '/renamed', expect: { status: 200, fields: { id: 'number', email: 'string' } } },
    { name: 'gone', url: base + '/missing', expect: { status: 200 } },
  ]);
  assert.equal(report.endpoints[0].findings.filter((f) => f.level === 'BREAKING').length, 0);
  assert.equal(report.endpoints[1].findings[0].level, 'BREAKING');
  assert.equal(report.endpoints[2].status, 404);
  assert.equal(report.counts.BREAKING, 2);
  assert.equal(report.counts.INFO, 2); // ok and renamed both carry extra fields
});

test('non-JSON responses are breaking', async () => {
  const e = await checkEndpoint({ name: 'h', url: base + '/html', expect: { status: 200 } });
  assert.equal(e.findings[0].message, 'response is not JSON');
});

test('a server that never answers is reported as a timeout, not a hang', async () => {
  const e = await checkEndpoint({ name: 's', url: base + '/slow', expect: {} }, fetch, 200);
  assert.equal(e.status, null);
  assert.match(e.findings[0].message, /no response within 200 ms/);
});

test('CLI: init snapshots a contract, then check exits 0 on the same data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apiwatch-'));
  const file = join(dir, 'contracts.json');
  const init = await cli(['init', 'users', base + '/ok', '--out', file]);
  assert.equal(init.status, 0, init.stderr);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved[0].name, 'users');
  const r = await cli(['check', file]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('CLI: check exits 1 on breaking change and 2 on a bad contracts file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apiwatch-'));
  const file = join(dir, 'c.json');
  writeFileSync(file, JSON.stringify([{ name: 'r', url: base + '/renamed', expect: { fields: { email: 'string' } } }]));
  const broken = await cli(['check', file, '--json', join(dir, 'report.json')]);
  assert.equal(broken.status, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).counts.BREAKING, 1);
  writeFileSync(file, '{"not":"an array"}');
  assert.equal((await cli(['check', file])).status, 2);
});
