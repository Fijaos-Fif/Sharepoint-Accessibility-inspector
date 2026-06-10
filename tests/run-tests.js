#!/usr/bin/env node
// Harness de non-régression — Audit Accessibilité SharePoint
//
// Usage :
//   node tests/run-tests.js            # compare avec tests/expected.json (échoue si écart)
//   node tests/run-tests.js --update   # régénère tests/expected.json (nouvelle baseline)
//
// Ce qu'il vérifie :
//   1. Syntaxe : audit-injector-ui.js + JS extrait du HTML parsables
//   2. Bundle : marqueurs de slicing présents + fonctions attendues dans la slice (comme start.py)
//   3. Audit : comptes de findings (total + par sévérité) sur chaque page de tests/
//   4. Retag : taux de re-matching normal→édition sur les paires X-normal / X-edit
//
// Dépendance jsdom installée hors OneDrive dans ~/.audit-a11y-deps (auto-install au 1er run).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'audit-accessibilite-sharepoint.html');
const INJECTOR_PATH = path.join(ROOT, 'audit-injector-ui.js');
const EXPECTED_PATH = path.join(__dirname, 'expected.json');
const UPDATE = process.argv.includes('--update');
const DEPS_DIR = path.join(os.homedir(), '.audit-a11y-deps');

let failures = [];
const ok = (m) => console.log('  ✓ ' + m);
const ko = (m) => { failures.push(m); console.log('  ✗ ' + m); };

// ── Dépendance jsdom (durable, hors OneDrive) ──
function loadJSDOM() {
  const modPath = path.join(DEPS_DIR, 'node_modules', 'jsdom');
  if (!fs.existsSync(modPath)) {
    console.log('jsdom absent — installation dans ' + DEPS_DIR + ' …');
    fs.mkdirSync(DEPS_DIR, { recursive: true });
    execSync('npm install --prefix "' + DEPS_DIR + '" jsdom@19 --no-fund --no-audit --loglevel=error', { stdio: 'inherit' });
  }
  return require(modPath);
}

// ── 1. Syntaxe ──
function checkSyntax() {
  console.log('\n[1/4] Syntaxe');
  try { execFileSync(process.execPath, ['--check', INJECTOR_PATH], { stdio: 'pipe' }); ok('audit-injector-ui.js parsable'); }
  catch (e) { ko('audit-injector-ui.js : erreur de syntaxe\n' + e.stderr); }

  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!m) { ko('bloc <script> principal introuvable dans le HTML'); return null; }
  const tmp = path.join(os.tmpdir(), 'audit-full-script.js');
  fs.writeFileSync(tmp, m[1]);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); ok('JS du HTML parsable'); }
  catch (e) { ko('JS du HTML : erreur de syntaxe\n' + e.stderr); }
  return m[1];
}

// ── 2. Bundle (mêmes marqueurs que start.py) ──
function checkBundle(script) {
  console.log('\n[2/4] Slicing bundle (marqueurs start.py)');
  const start = script.indexOf('// ═══ SHAREPOINT SCOPING ═══');
  const end = script.indexOf('// UI\n');
  if (start < 0) { ko('marqueur de début "// ═══ SHAREPOINT SCOPING ═══" absent'); return; }
  if (end < 0 || end <= start) { ko('marqueur de fin "// UI\\n" absent ou mal placé'); return; }
  ok('marqueurs présents (slice de ' + Math.round((end - start) / 1024) + ' Ko)');
  const slice = script.slice(start, end);
  for (const fn of ['runAudit', 'aiReformulate', 'buildAIPrompt', 'retagDOMFromIssues', 'aiPromptDefaults', 'imgElementToDataUrl']) {
    if (slice.includes('function ' + fn) || slice.includes('async function ' + fn)) ok(fn + ' dans la slice');
    else ko(fn + ' ABSENT de la slice bundle');
  }
}

// ── Extraction du core audit pour exécution jsdom ──
function buildCoreModule(script) {
  const lines = script.split('\n');
  const cutIdx = lines.findIndex(l => l.includes("$('#html-input').addEventListener"));
  if (cutIdx < 0) throw new Error("point de coupe \"$('#html-input').addEventListener\" introuvable");
  const core = lines.slice(0, cutIdx).join('\n') +
    '\nmodule.exports = {runAudit, retagDOMFromIssues, APP_VERSION};';
  const corePath = path.join(os.tmpdir(), 'audit-core-extracted.js');
  fs.writeFileSync(corePath, core);
  return corePath;
}

function requireCoreFor(dom, corePath) {
  Object.assign(global, {
    document: dom.window.document, window: dom.window,
    DOMParser: dom.window.DOMParser, Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter, getComputedStyle: dom.window.getComputedStyle,
    location: dom.window.location, localStorage: undefined,
  });
  delete require.cache[corePath];
  return require(corePath);
}

// ── Découverte des pages : paires X(-normal) / X-edit ──
function discoverPages() {
  const entries = {};
  for (const f of fs.readdirSync(__dirname)) {
    if (!f.endsWith('.html')) continue;
    let base = f.slice(0, -5).trim();
    let role = 'normal';
    if (/-edit$/.test(base)) { role = 'edit'; base = base.replace(/-edit$/, '').trim(); }
    else if (/-normal$/.test(base)) { base = base.replace(/-normal$/, '').trim(); }
    (entries[base] = entries[base] || {})[role] = path.join(__dirname, f);
  }
  return entries;
}

// ── 3+4. Audit + retag ──
function severityCounts(issues) {
  const c = {};
  for (const i of issues) c[i.severity] = (c[i.severity] || 0) + 1;
  return c;
}

function runPages(corePath, jsdom) {
  const { JSDOM, VirtualConsole } = jsdom;
  // VirtualConsole muette : les CSS SP/O365 font hurler le parseur jsdom (inoffensif)
  const newDOM = (file) => new JSDOM(fs.readFileSync(file, 'utf8'), { virtualConsole: new VirtualConsole() });
  const pages = discoverPages();
  const results = {};
  console.log('\n[3/4] Audit des pages');
  for (const [base, files] of Object.entries(pages)) {
    if (!files.normal) { console.log('  – ' + base + ' : pas de version normale, ignorée'); continue; }
    const t0 = Date.now();
    const dom = newDOM(files.normal);
    const core = requireCoreFor(dom, corePath);
    const R = core.runAudit(dom.window.document);
    const issues = R.issues || [];
    const res = {
      issues: issues.length,
      severities: severityCounts(issues),
      longSentences: (R.readability && R.readability.longSentences || []).length,
    };
    if (files.edit) {
      const editDom = newDOM(files.edit);
      Object.assign(global, { document: editDom.window.document, window: editDom.window });
      const taggable = issues.filter(i => i.targetId != null);
      core.retagDOMFromIssues(taggable, editDom.window.document);
      const matched = taggable.filter(i =>
        editDom.window.document.querySelector('[data-audit-id="' + i.targetId + '"]')).length;
      res.retag = { matched, taggable: taggable.length };
    }
    results[base] = res;
    const retagStr = res.retag ? (' | retag ' + res.retag.matched + '/' + res.retag.taggable) : '';
    console.log('  • ' + base + ' : ' + res.issues + ' findings' + retagStr + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
  }
  return results;
}

// ── Comparaison avec la baseline ──
function compare(results) {
  console.log('\n[4/4] Comparaison baseline');
  if (UPDATE || !fs.existsSync(EXPECTED_PATH)) {
    fs.writeFileSync(EXPECTED_PATH, JSON.stringify(results, null, 2));
    console.log('  baseline ' + (UPDATE ? 'mise à jour' : 'créée') + ' → tests/expected.json');
    return;
  }
  const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
  for (const [base, exp] of Object.entries(expected)) {
    const got = results[base];
    if (!got) { ko(base + ' : page attendue absente de tests/'); continue; }
    if (got.issues !== exp.issues) ko(base + ' : ' + got.issues + ' findings (attendu ' + exp.issues + ')');
    else ok(base + ' : ' + exp.issues + ' findings');
    if (JSON.stringify(got.severities) !== JSON.stringify(exp.severities))
      ko(base + ' : répartition sévérités ' + JSON.stringify(got.severities) + ' ≠ ' + JSON.stringify(exp.severities));
    if (exp.retag) {
      if (!got.retag) ko(base + ' : version -edit attendue absente');
      else if (got.retag.matched < exp.retag.matched)
        ko(base + ' : retag ' + got.retag.matched + '/' + got.retag.taggable + ' (baseline ' + exp.retag.matched + '/' + exp.retag.taggable + ')');
      else ok(base + ' : retag ' + got.retag.matched + '/' + got.retag.taggable);
    }
  }
  for (const base of Object.keys(results))
    if (!expected[base]) console.log('  – ' + base + ' : nouvelle page hors baseline (lance --update pour l\'inclure)');
}

// ── Main ──
const script = checkSyntax();
if (script) {
  checkBundle(script);
  const jsdomLib = loadJSDOM();
  const corePath = buildCoreModule(script);
  const results = runPages(corePath, jsdomLib);
  compare(results);
}

console.log('');
if (failures.length) { console.log('ÉCHEC — ' + failures.length + ' problème(s)'); process.exit(1); }
console.log('OK — non-régression validée');
