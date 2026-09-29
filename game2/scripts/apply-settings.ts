/**
 * Make a downloaded settings file the new repo defaults.
 *
 *   npm run apply-settings -- path/to/zerog-settings.json [--dry-run]
 *
 * Validates the file (schemaVersion ≤ 2), sanitizes it through the same schema
 * the app uses (unknown keys ignored, numbers clamped to their slider ranges),
 * keeps current defaults for keys the file does not contain, prints what changes
 * and rewrites src/config/default-settings.json. Then run tests/typecheck/build.
 *
 * Runs on Node's built-in TypeScript type stripping (Node ≥ 22.6), no extra deps.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, PARAMS, SETTINGS_SCHEMA_VERSION } from '../src/config/schema.ts';
import { canonicalDefaultsJson, parseSettingsFile } from '../src/config/settingsFile.ts';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../src/config/default-settings.json');

function fail(msg: string): never {
  console.error(`apply-settings: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));
if (!file) fail('usage: npm run apply-settings -- path/to/zerog-settings.json [--dry-run]');

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
} catch (e) {
  fail(`cannot read JSON from ${file}: ${(e as Error).message}`);
}

let parsed: ReturnType<typeof parseSettingsFile>;
try {
  parsed = parseSettingsFile(raw, DEFAULT_SETTINGS);
} catch (e) {
  fail((e as Error).message);
}
if (parsed.schemaVersion !== SETTINGS_SCHEMA_VERSION)
  console.warn(`apply-settings: note — file has schemaVersion ${parsed.schemaVersion}, converting to ${SETTINGS_SCHEMA_VERSION}.`);
if (parsed.applied === 0) fail('the file contains no known settings.');

const values = ((raw as Record<string, unknown>).settings ?? raw) as Record<string, unknown>;
const changes: string[] = [];
const clamped: string[] = [];
const missing: string[] = [];
for (const p of PARAMS) {
  const before = DEFAULT_SETTINGS[p.key];
  const after = parsed.settings[p.key];
  if (values[p.key] === undefined) missing.push(p.key);
  else if (values[p.key] !== after) clamped.push(`${p.key}: ${JSON.stringify(values[p.key])} → ${JSON.stringify(after)}`);
  if (before !== after) changes.push(`  ${p.key}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
}

console.log(`apply-settings: ${parsed.applied}/${PARAMS.length} settings read from ${file}`);
if (parsed.ignored.length) console.log(`  ignored unknown keys: ${parsed.ignored.join(', ')}`);
if (clamped.length) console.log(`  sanitized (out of range / wrong type):\n    ${clamped.join('\n    ')}`);
if (missing.length)
  console.log(
    `  not in file, kept current default: ${missing.length > 12 ? `${missing.length} keys` : missing.join(', ')}`,
  );
console.log(changes.length ? `  ${changes.length} default(s) change:\n${changes.join('\n')}` : '  no default changes.');

if (dryRun) {
  console.log('  --dry-run: nothing written.');
} else if (changes.length) {
  writeFileSync(target, canonicalDefaultsJson(parsed.settings));
  console.log(`  wrote ${target}\n  next: npm test && npm run typecheck && npm run build`);
}
