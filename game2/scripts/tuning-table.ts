/**
 * Prints the default-parameter tables for TUNING.md from the schema + canonical
 * defaults, so the docs never drift from the code:
 *
 *   npm run tuning-table > tuning-table.md
 */
import { PARAM_GROUPS, PARAMS, type ParamDef } from '../src/config/schema.ts';

const fmt = (v: unknown) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));
for (const g of PARAM_GROUPS) {
  console.log(`### ${g}\n`);
  console.log('| key | default | range | what it changes |');
  console.log('|---|---|---|---|');
  for (const p of PARAMS as readonly ParamDef[]) {
    if (p.group !== g) continue;
    const range = p.type === 'bool' ? 'on/off' : p.type === 'select' ? p.options.join(' / ') : `${p.min} – ${p.max}`;
    const what = p.help ? `${p.label} — ${p.help}` : p.label;
    console.log(`| \`${p.key}\` | ${fmt(p.default)} | ${range} | ${what.replace(/\|/g, '\\|')} |`);
  }
  console.log('');
}
