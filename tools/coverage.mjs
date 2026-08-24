// Port coverage — is every control the legacy app offers accounted for?
//
//   npm run coverage           report
//   npm run coverage -- --sync add newly-found legacy controls to the map as "todo"
//
// WHY THIS EXISTS. "Make sure all functionality remains" is unfalsifiable without a
// list. The legacy app is one 16,000-line file with 348 user-facing controls, and it
// is STILL GAINING THEM — main added 4,000 lines in six weeks. A port judged by
// reading it will miss things, and the missing thing will be found by an estimator
// who cannot price a job.
//
// Function names cannot be the unit of measure: a faithful React port legitimately
// renames and restructures them. What must survive is the SURFACE — every input,
// select, textarea and button the user can touch. So that is what is tracked.
//
// tools/port-coverage.json maps each legacy control id to where it went:
//
//   "adc-cv-intercom-devices": { "status": "done",    "where": "src/tabs/QuoteBuilder/Adc.jsx" }
//   "bom-vendor-group":        { "status": "todo" }
//   "p1-login-input":          { "status": "dropped", "why": "Entra replaces the password gate" }
//
// "dropped" is a first-class outcome and must carry a reason — some legacy controls
// SHOULD NOT be ported, and silently omitting them is indistinguishable from missing
// them.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LEGACY = new URL('../legacy/index.html', import.meta.url);
const MAP_PATH = new URL('./port-coverage.json', import.meta.url);

// Controls the user can operate. Not every element with an id — a <div id="panel">
// is layout, and tracking it would drown the signal.
const CONTROL_RE = /<(input|select|textarea|button)\b[^>]*\bid=["']([a-zA-Z0-9_-]+)["']/gi;

function legacyControls() {
  const html = readFileSync(LEGACY, 'utf8');
  const found = new Map();
  for (const m of html.matchAll(CONTROL_RE)) {
    const tag = m[1].toLowerCase();
    const id = m[2];
    if (!found.has(id)) found.set(id, tag);
  }
  return found;
}

function loadMap() {
  if (!existsSync(MAP_PATH)) return {};
  return JSON.parse(readFileSync(MAP_PATH, 'utf8'));
}

const controls = legacyControls();
const map = loadMap();
const sync = process.argv.includes('--sync');

// Anything in the legacy that the map has never seen. On a --sync run these are
// recorded as todo; otherwise they are reported, because a control appearing here
// means main grew one and nobody has decided what to do with it.
const unmapped = [...controls.keys()].filter((id) => !map[id]);

if (sync && unmapped.length) {
  for (const id of unmapped) {
    map[id] = { status: 'todo', tag: controls.get(id) };
  }
  // Sorted so the file diffs cleanly when two people sync on the same day.
  const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
  writeFileSync(MAP_PATH, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`  Added ${unmapped.length} newly-found control(s) as "todo".`);
}

// A mapped control the legacy no longer has. Either it was removed upstream (so the
// entry is stale) or an id was renamed — worth knowing either way, because a port
// built against a control that no longer exists is porting a ghost.
const stale = Object.keys(map).filter((id) => !controls.has(id));

const byStatus = { done: [], todo: [], dropped: [], partial: [] };
for (const [id, entry] of Object.entries(map)) {
  if (!controls.has(id)) continue;
  (byStatus[entry.status] ||= []).push(id);
}

const total = controls.size;
const done = byStatus.done.length;
const dropped = byStatus.dropped.length;
const partial = byStatus.partial.length;
const todo = byStatus.todo.length;
const accounted = done + dropped;
const pct = total ? Math.round((accounted / total) * 100) : 0;

console.log('');
console.log(`  Legacy controls:   ${total}`);
console.log(`    done             ${done}`);
console.log(`    partial          ${partial}`);
console.log(`    dropped          ${dropped}   (deliberately not ported)`);
console.log(`    todo             ${todo}`);
console.log(`    unmapped         ${unmapped.length}   (new in legacy — run --sync)`);
console.log('');
console.log(`  Accounted for:     ${accounted}/${total}  (${pct}%)`);

if (stale.length) {
  console.log('');
  console.log(`  ${stale.length} mapped control(s) no longer exist in the legacy:`);
  for (const id of stale.slice(0, 10)) console.log(`    ${id}`);
  if (stale.length > 10) console.log(`    … and ${stale.length - 10} more`);
}

// A "dropped" entry without a reason is how a decision becomes an accident.
const unreasoned = Object.entries(map)
  .filter(([, e]) => e.status === 'dropped' && !e.why)
  .map(([id]) => id);
if (unreasoned.length) {
  console.log('');
  console.log(`  ${unreasoned.length} dropped control(s) have no "why" — add one:`);
  for (const id of unreasoned.slice(0, 10)) console.log(`    ${id}`);
}

if (unmapped.length && !sync) {
  console.log('');
  console.log(`  ${unmapped.length} control(s) in the legacy are not in the map. These are`);
  console.log(`  features main has that this port has not decided about:`);
  for (const id of unmapped.slice(0, 20)) console.log(`    ${controls.get(id).padEnd(9)} ${id}`);
  if (unmapped.length > 20) console.log(`    … and ${unmapped.length - 20} more`);
  console.log('');
  console.log(`  Run: npm run coverage -- --sync`);
}

console.log('');
process.exit(unreasoned.length ? 1 : 0);
