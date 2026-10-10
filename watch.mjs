#!/usr/bin/env node
/**
 * api-watch — catch breaking API changes before your users do.
 *
 * A contract records the response shape your app depends on. `check` compares
 * live responses to it and reports:
 *  - BREAKING: unreachable, wrong status, missing field, changed type, sunset soon
 *  - WARNING:  Deprecation header, sunset later than the window
 *  - INFO:     new fields the contract does not mention
 * For each missing field it suggests same-typed fields that may be the rename.
 * Those are hints for a human to verify, not verified fixes.
 *
 * `init` snapshots a contract from a live JSON response, so you start from
 * reality instead of hand-writing the shape.
 *
 * Usage:
 *   api-watch check contracts.json [--json out.json] [--md out.md]
 *                  [--timeout 10000] [--fail-on breaking|warning]
 *   api-watch init <name> <url> [--out contracts.json] [--header "Name: ${ENV_VAR}"]...
 *                  (secrets stay in the environment; contracts.json stores only ${VAR} placeholders)
 *
 * Exit: 0 clean · 1 breaking (or warning when --fail-on warning) · 2 bad input
 */
import { readFileSync, writeFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const SUNSET_WINDOW_DAYS = 60;
export const DEFAULT_TIMEOUT_MS = 10000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);
function readContracts(file) {
  if (!statSync(file).isFile() || statSync(file).size > 2 * 1024 * 1024) throw new Error('contracts input must be a regular file under 2 MiB');
  return validateContracts(JSON.parse(readFileSync(file, 'utf8')));
}
const safeText = (v) => String(v).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/([\\`*_\[\]])/g, '\\$1');

function validateUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL must be HTTP(S) without embedded credentials');
  if ([...url.searchParams.keys()].some((key) => SECRET_HEADER.test(key))) throw new Error('credentials must be in environment-backed headers, not URL query parameters');
  return url;
}

function timeoutValue(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2147483647) throw new Error('timeout must be a positive integer at most 2147483647');
  return ms;
}

function validateTemplates(templates = {}) {
  if (!plain(templates)) throw new Error('headers must be an object');
  for (const [name, value] of Object.entries(templates)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n\x00]/.test(value)) throw new Error('invalid header template');
    if (SECRET_HEADER.test(name) && !/^(?:Bearer |Basic )?\$\{[A-Z_][A-Z0-9_]*\}$/.test(value)) throw new Error(`refusing to save a literal value for "${name}"; use an environment placeholder`);
  }
}

export function validateContracts(contracts) {
  if (!Array.isArray(contracts) || contracts.length === 0 || contracts.length > 100) throw new Error('contracts must be a nonempty array of at most 100 entries');
  const names = new Set();
  for (const c of contracts) {
    if (!plain(c) || typeof c.name !== 'string' || !c.name.trim() || names.has(c.name) || typeof c.url !== 'string' || !plain(c.expect)) throw new Error('invalid or duplicate contract');
    names.add(c.name);
    validateUrl(c.url);
    validateTemplates(c.headers);
    if (c.expect.status !== undefined && (!Number.isInteger(c.expect.status) || c.expect.status < 100 || c.expect.status > 599)) throw new Error('invalid expected status');
    if (c.expect.array !== undefined && typeof c.expect.array !== 'boolean') throw new Error('array must be boolean');
    if (c.expect.fields !== undefined && (!plain(c.expect.fields) || Object.values(c.expect.fields).some((t) => !['string', 'number', 'boolean', 'object', 'array', 'null'].includes(t)))) throw new Error('invalid expected fields');
  }
  return contracts;
}

async function boundedText(res) {
  if (Number(res.headers.get('content-length')) > MAX_RESPONSE_BYTES) { await res.body?.cancel(); throw new Error('response exceeds 2 MiB limit'); }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('response exceeds 2 MiB limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// Header names that usually carry credentials. init refuses to save literal values for these.
const SECRET_HEADER = /authorization|cookie|token|secret|api-?key|key$/i;

/** Replace ${VAR} with environment values. Reports variables that are unset or empty. */
export function expandEnv(template, env = process.env) {
  const missing = [];
  const value = template.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
    if (env[name] === undefined || env[name] === '') {
      missing.push(name);
      return '';
    }
    return env[name];
  });
  return { value, missing };
}

/** Build request headers from contract templates. Always sends Accept: application/json. */
export function resolveHeaders(templates = {}, env = process.env) {
  validateTemplates(templates);
  const headers = { accept: 'application/json' };
  const missing = [];
  for (const [name, template] of Object.entries(templates)) {
    const r = expandEnv(template, env);
    if (/[\r\n\x00]/.test(r.value)) throw new Error('invalid expanded header value');
    Object.defineProperty(headers, name, { value: r.value, enumerable: true });
    for (const variable of r.missing) missing.push({ header: name, variable });
  }
  return { headers, missing };
}

/** "Name: value" strings to an object, split on the first colon. Returns null if any entry is malformed. */
export function parseHeaderArgs(list) {
  const out = {};
  for (const h of list) {
    const i = h.indexOf(':');
    if (i < 1) return null;
    Object.defineProperty(out, h.slice(0, i).trim(), { value: h.slice(i + 1).trim(), enumerable: true, configurable: true });
  }
  return out;
}

/** Find same-typed fields in the response that the contract does not expect. */
function renameHints(missingName, missingType, body, expectedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body)
    .filter((k) => !own(expectedFields, k) && typeOf(body[k]) === missingType)
    .map((k) => `"${k}" (${missingType}) may be the renamed "${missingName}"`);
}

export function checkBody(contract, status, headers, body) {
  const findings = [];
  const add = (level, message) => findings.push({ level, message });
  const { expect } = contract;

  if (expect.status !== undefined && status !== expect.status) {
    add('BREAKING', `status ${status}, expected ${expect.status}`);
  }

  const dep = headers.get?.('deprecation') ?? headers.deprecation;
  if (dep) add('WARNING', `Deprecation header present: ${dep}`);
  const sunset = headers.get?.('sunset') ?? headers.sunset;
  if (sunset) {
    const when = Date.parse(sunset);
    const days = Number.isNaN(when) ? null : Math.round((when - Date.now()) / 86400000);
    if (days === null) add('WARNING', `Sunset header unparseable: ${sunset}`);
    else if (days <= SUNSET_WINDOW_DAYS) add('BREAKING', `Sunset in ${days} day(s) (${sunset})`);
    else add('WARNING', `Sunset ${sunset} (${days} days away)`);
  }

  if (expect.array && !Array.isArray(body)) {
    add('BREAKING', `response is ${typeOf(body)}, expected array`);
  }
  const probe = expect.array ? (Array.isArray(body) ? body[0] : undefined) : body;

  const fields = expect.fields ?? {};
  for (const [name, wantType] of Object.entries(fields)) {
    if (!probe || typeof probe !== 'object' || !own(probe, name)) {
      const hints = renameHints(name, wantType, probe, fields);
      add('BREAKING', `missing field "${name}" (${wantType})` + (hints.length ? `; hint: ${hints.join('; ')}` : ''));
      continue;
    }
    const got = typeOf(probe[name]);
    if (got !== wantType) add('BREAKING', `field "${name}" is ${got}, expected ${wantType}`);
  }

  if (probe && typeof probe === 'object' && !Array.isArray(probe)) {
    const extra = Object.keys(probe).filter((k) => !own(fields, k));
    if (extra.length) add('INFO', `new fields not in contract: ${extra.join(', ')}`);
  }
  return findings;
}

export async function checkEndpoint(contract, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env) {
  validateContracts([contract]);
  timeoutValue(timeoutMs);
  const url = validateUrl(contract.url);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Object.keys(contract.headers ?? {}).some((k) => SECRET_HEADER.test(k))) throw new Error('credential headers require HTTPS (except loopback tests)');
  const { headers, missing } = resolveHeaders(contract.headers, env);
  if (missing.length) {
    return {
      name: contract.name,
      url: contract.url,
      status: null,
      findings: missing.map((m) => ({ level: 'BREAKING', message: `missing environment variable ${m.variable} for header "${m.header}"; request not sent` })),
    };
  }
  let res;
  let text;
  try {
    res = await fetchImpl(contract.url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await boundedText(res);
  } catch (e) {
    const reason = ['TimeoutError', 'AbortError'].includes(e?.name) ? `no response within ${timeoutMs} ms` : (e.message === 'response exceeds 2 MiB limit' ? e.message : 'request or response failed');
    return { name: contract.name, url: contract.url, status: null, findings: [{ level: 'BREAKING', message: `unreachable: ${reason}` }] };
  }
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    return {
      name: contract.name,
      url: contract.url,
      status: res.status,
      findings: [{ level: 'BREAKING', message: 'response is not JSON' }],
    };
  }
  return {
    name: contract.name,
    url: contract.url,
    status: res.status,
    findings: checkBody(contract, res.status, res.headers, body),
  };
}

export async function runWatch(contracts, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  validateContracts(contracts);
  timeoutValue(timeoutMs);
  const endpoints = [];
  for (const c of contracts) endpoints.push(await checkEndpoint(c, fetchImpl, timeoutMs));
  const counts = { BREAKING: 0, WARNING: 0, INFO: 0 };
  for (const e of endpoints) for (const f of e.findings) counts[f.level]++;
  return { checkedAt: new Date().toISOString(), counts, endpoints };
}

/**
 * Derive a contract from a live response. Top-level keys of an object, or the
 * keys of the first element of an array, become expected fields with their types.
 */
export function deriveContract(name, url, status, body, headers = {}) {
  const isArray = Array.isArray(body);
  const sample = isArray ? body[0] : body;
  const fields = {};
  if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
    for (const [k, v] of Object.entries(sample)) Object.defineProperty(fields, k, { value: typeOf(v), enumerable: true });
  }
  const expect = { status };
  if (isArray) expect.array = true;
  expect.fields = fields;
  const contract = { name, url, expect };
  if (Object.keys(headers).length) contract.headers = headers;
  return contract;
}

export function toMarkdown(report) {
  const lines = [`# API watch — ${report.checkedAt}`, '', `Breaking: ${report.counts.BREAKING} · Warnings: ${report.counts.WARNING} · Info: ${report.counts.INFO}`, ''];
  for (const e of report.endpoints) {
    lines.push(`## ${safeText(e.name)} (${e.status ?? 'no response'})`);
    if (e.findings.length === 0) lines.push('- no changes');
    for (const f of e.findings) lines.push(`- **${f.level}** ${safeText(f.message)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function setExit(code) {
  // Set, do not force-exit: process.exit() while a keep-alive socket is open trips a libuv assertion on Windows.
  process.exitCode = code;
  return code;
}

function usage() {
  return [
    'usage:',
    '  api-watch check contracts.json [--json out.json] [--md out.md] [--timeout ms] [--fail-on breaking|warning]',
    '  api-watch init <name> <url> [--out contracts.json] [--header "Name: ${ENV_VAR}"]...',
  ].join('\n');
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'string' },
      md: { type: 'string' },
      out: { type: 'string' },
      header: { type: 'string', multiple: true },
      timeout: { type: 'string', default: String(DEFAULT_TIMEOUT_MS) },
      'fail-on': { type: 'string', default: 'breaking' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(usage());
    return setExit(values.help ? 0 : 2);
  }
  const [command, ...rest] = positionals;
  const timeout = timeoutValue(Number(values.timeout));

  if (command === 'init') {
    const [name, url] = rest;
    if (!name || !url || rest.length !== 2) {
      console.error(usage());
      return setExit(2);
    }
    const templates = parseHeaderArgs(values.header ?? []);
    if (!templates) {
      console.error('--header must look like "Name: value"');
      return setExit(2);
    }
    validateUrl(url);
    validateTemplates(templates);
    const secret = Object.entries(templates).find(([k, v]) => SECRET_HEADER.test(k) && !v.includes('${'));
    if (secret) {
      console.error(`init: refusing to save a literal value for "${secret[0]}" in contracts.json; use \${ENV_VAR} instead`);
      return setExit(2);
    }
    const resolved = resolveHeaders(templates);
    if (resolved.missing.length) {
      console.error(`init: missing environment variable ${resolved.missing[0].variable} for header "${resolved.missing[0].header}"`);
      return setExit(1);
    }
    let res;
    try {
      const target = validateUrl(url);
      if (target.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && Object.keys(templates).some((k) => SECRET_HEADER.test(k))) throw new Error('credential headers require HTTPS');
      res = await fetch(url, { headers: resolved.headers, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      console.error('init: request failed (redirects and insecure credential transport are refused)');
      return setExit(1);
    }
    let body;
    try {
      body = JSON.parse(await boundedText(res));
    } catch {
      console.error(`init: ${url} did not return JSON (status ${res.status})`);
      return setExit(1);
    }
    const contract = deriveContract(name, url, res.status, body, templates);
    const outFile = values.out ?? 'contracts.json';
    const list = existsSync(outFile) ? readContracts(outFile) : [];
    const next = [...list.filter((c) => c.name !== name), contract];
    validateContracts(next);
    writeFileSync(outFile, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    console.log(`wrote contract "${name}" (${Object.keys(contract.expect.fields).length} field(s)) to ${outFile}`);
    return setExit(0);
  }

  if (command !== 'check' && !command.endsWith('.json')) {
    console.error(usage());
    return setExit(2);
  }
  const file = command === 'check' ? rest[0] : command;
  if (!file) {
    console.error(usage());
    return setExit(2);
  }
  if (!['breaking', 'warning'].includes(values['fail-on'])) {
    console.error('--fail-on must be "breaking" or "warning"');
    return setExit(2);
  }
  let contracts;
  try {
    contracts = readContracts(file);
  } catch (e) {
    console.error(`bad contracts file: ${e.message}`);
    return setExit(2);
  }
  const outputs = [values.json, values.md].filter(Boolean);
  const targets = outputs.map((p) => existsSync(p) ? realpathSync(p) : resolve(p));
  if (targets.includes(realpathSync(file)) || new Set(targets).size !== targets.length) throw new Error('report paths must differ from input and each other');
  if (outputs.some((p) => existsSync(p))) throw new Error('report output already exists; choose a new filename');
  const report = await runWatch(contracts, fetch, timeout);
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (values.md) writeFileSync(values.md, toMarkdown(report), { flag: 'wx', mode: 0o600 });
  console.log(toMarkdown(report));
  const failing = report.counts.BREAKING > 0 || (values['fail-on'] === 'warning' && report.counts.WARNING > 0);
  return setExit(failing ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // Usage errors (e.g. unknown flags) exit 2 with a one-line message, never a stack trace.
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e.message).replace(/[\r\n\x1b]/g, ' '));
    setExit(2);
  });
}
