import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

export function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(value => walk(value, visit));
    else if (child && typeof child === 'object') walk(child, visit);
  }
}

const ast = (file, text) => parseAst(text, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }, file);
const group = file => path.posix.basename(file).match(/^(procurement|research|sales)/i)?.[1].toLowerCase();

export function dependencyFindings(sources, policy) {
  const findings = [], graph = new Map();
  for (const [file, text] of Object.entries(sources)) {
    const edges = new Set(); graph.set(file, edges);
    walk(ast(file, text), node => {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression', 'TSImportType'].includes(node.type)) return;
      const source = node.source ?? node.argument;
      if (!source) return;
      if (typeof source.value !== 'string') {
        findings.push(`${file}: computed module import cannot be checked`); return;
      }
      const specifier = source.value;
      if (specifier.startsWith('@/')) { findings.push(`${file}: undeclared alias ${specifier}`); return; }
      if (!specifier.startsWith('.') && !specifier.startsWith('/src/')) return;
      if (/\.(css|svg|png|jpg|json)$/.test(specifier)) return; // Assets are checked by the unchanged build gate.
      const base = path.posix.normalize(specifier.startsWith('/src/') ? specifier.slice(1) : path.posix.join(path.posix.dirname(file), specifier));
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(candidate => Object.hasOwn(sources, candidate));
      if (!target) { findings.push(`${file}: unresolved local module ${specifier}`); return; }
      edges.add(target); // Type imports also participate in architectural cycles.
      const names = node.type === 'TSImportType' ? [node.qualifier?.name ?? '*'] : node.specifiers?.map(row => row.type === 'ImportDefaultSpecifier' ? 'default' : row.type === 'ImportNamespaceSpecifier' ? '*' : row.imported?.name ?? row.imported?.value ?? row.local?.name ?? '*') ?? ['*'];
      const businessComponent = Object.hasOwn(policy.businessComponents, target);
      if (file.startsWith('src/components/') && !Object.hasOwn(policy.businessComponents, file)
        && (target === 'src/api.ts' || target.startsWith('src/screens/') || target.startsWith('src/workbenches/') || businessComponent)) {
        findings.push(`${file}: shared control depends on business implementation ${target}`);
      }
      if (target.startsWith('src/workbenches/')) {
        const sameModule = group(file) && group(file) === group(target) && file.startsWith('src/workbenches/');
        const entry = file === 'src/workbenches/WorkbenchModuleSlot.tsx' && policy.entries.includes(target);
        const shell = file === 'src/screens/WorkbenchScreen.tsx' && target === 'src/workbenches/WorkbenchModuleSlot.tsx' && names.every(name => name === 'WorkbenchModuleSlot');
        const exception = policy.compatibility.find(row => row.from === file && row.to === target && names.every(name => row.symbols.includes(name)));
        if (!sameModule && !entry && !shell && !exception) findings.push(`${file}: unapproved internal import ${target} (${names.join(', ')})`);
      }
    });
  }
  const restricted = file => file === 'src/api.ts' || file.startsWith('src/screens/') || file.startsWith('src/workbenches/') || Object.hasOwn(policy.businessComponents, file);
  for (const file of graph.keys()) {
    if (!file.startsWith('src/components/') || Object.hasOwn(policy.businessComponents, file)) continue;
    const seen = new Set();
    const inspect = (target, trail) => {
      if (seen.has(target)) return;
      seen.add(target);
      if (target !== file && restricted(target)) { findings.push(`${file}: shared control reaches business implementation ${[...trail, target].join(' -> ')}`); return; }
      walk(ast(target, sources[target]), node => {
        if (node.type === 'CallExpression' && (node.callee.name === 'fetch' || node.callee.property?.name === 'fetch')
          || node.type === 'NewExpression' && ['XMLHttpRequest', 'WebSocket'].includes(node.callee.name)) findings.push(`${file}: shared control reaches network request in ${target}; requests belong in the business layer`);
      });
      for (const edge of graph.get(target)) inspect(edge, [...trail, target]);
    };
    inspect(file, []);
  }
  const complete = new Set();
  const visit = (file, stack) => {
    if (stack.includes(file)) { findings.push(`dependency cycle: ${[...stack.slice(stack.indexOf(file)), file].join(' -> ')}`); return; }
    if (complete.has(file)) return;
    for (const target of graph.get(file) ?? []) visit(target, [...stack, file]);
    complete.add(file);
  };
  for (const file of graph.keys()) visit(file, []);
  return [...new Set(findings)].sort();
}

export function reactDiagnostics(files) {
  const result = spawnSync(process.execPath, ['node_modules/oxlint/bin/oxlint', '--config', '.oxlintrc.json', '--format', 'json', '--no-ignore', ...files], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.ok(result.status === 0 || result.status === 1, result.stderr || 'React checker did not complete');
  const output = JSON.parse(result.stdout);
  assert.equal(output.number_of_files, files.length, 'React checker must examine every supplied file');
  assert.equal(output.number_of_rules, 4, 'React rule set changed; review the check and its negative tests');
  assert.ok(Array.isArray(output.diagnostics));
  return output.diagnostics;
}

export function diagnosticEntry(diagnostic, text) {
  assert.ok(diagnostic.code && diagnostic.labels?.length, 'Unclassified lint/parser error must not enter the historical baseline');
  const file = diagnostic.filename.replaceAll('\\', '/');
  const offset = diagnostic.labels[0].span.offset;
  const position = Buffer.from(text).subarray(0, offset).toString('utf8').length;
  const calls = [];
  walk(ast(file, text), node => {
    if (node.type === 'CallExpression' && /^use[A-Z]/.test(node.callee.name ?? node.callee.property?.name ?? '') && node.start <= position && node.end >= position) calls.push(node);
  });
  const anchor = calls.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  const source = (anchor ? text.slice(anchor.start, anchor.end) : Buffer.from(text).subarray(offset, offset + diagnostic.labels[0].span.length).toString('utf8')).replaceAll('\r\n', '\n');
  return { file, rule: diagnostic.code, message: diagnostic.message, anchor: createHash('sha256').update(source).digest('hex'), line: diagnostic.labels[0].span.line };
}

export const entryKey = ({ file, rule, message, anchor }) => JSON.stringify([file, rule, message, anchor]);

function main() {
  const policy = JSON.parse(readFileSync('scripts/frontend-boundaries.json', 'utf8'));
  const baseline = JSON.parse(readFileSync('scripts/react-lint-baseline.json', 'utf8'));
  assert.equal(baseline.tool, 'oxlint@1.86.0');
  assert.ok(baseline.maintainer && baseline.reason && baseline.removeWhen);
  assert.ok(baseline.entries.every(row => row.rule === 'react-hooks(exhaustive-deps)'), 'New rule exceptions require a separate review');
  for (const row of [...Object.values(policy.businessComponents), ...policy.compatibility]) assert.ok(row.reason && row.maintainer && row.removeWhen);
  const files = readdirSync('src', { recursive: true }).filter(file => /\.tsx?$/.test(file)).map(file => 'src/' + file.replaceAll('\\', '/')).sort();
  const sources = Object.fromEntries(files.map(file => [file, readFileSync(file, 'utf8')]));
  const findings = dependencyFindings(sources, policy);
  for (const [file, text] of Object.entries(sources)) if (/(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable/.test(text)) findings.push(`${file}: inline lint suppression requires explicit review, not a hidden exception`);
  // ponytail: exact Hook snapshots tolerate line moves, not edited violations; review baseline changes alongside the affected consumer.
  const remaining = new Map();
  for (const row of baseline.entries) remaining.set(entryKey(row), (remaining.get(entryKey(row)) ?? 0) + 1);
  const diagnostics = reactDiagnostics(files);
  for (const diagnostic of diagnostics) {
    const row = diagnosticEntry(diagnostic, sources[diagnostic.filename.replaceAll('\\', '/')]);
    const key = entryKey(row), count = remaining.get(key) ?? 0;
    if (count) remaining.set(key, count - 1);
    else findings.push(`${row.file}:${row.line}: new React violation: ${row.rule}: ${row.message}`);
  }
  for (const [key, count] of remaining) if (count) findings.push(`stale historical entry (${count}): ${key}; remove or re-review it`);
  if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
  else console.log(`PASS frontend quality: ${files.length} modules; ${diagnostics.length} reviewed historical React findings, 0 new; no dependency cycles or boundary violations`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
