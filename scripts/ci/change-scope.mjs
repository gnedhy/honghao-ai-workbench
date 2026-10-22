import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const proseTags = new Set(['div', 'p', 'span', 'strong', 'em', 'small', 'li', 'h1', 'h2', 'h3']);
function staticProse(node) {
  return node.type === 'JSXText' || (node.type === 'JSXElement'
    && proseTags.has(node.openingElement.name.name)
    && node.openingElement.attributes.length === 0
    && node.children.length > 0 && node.children.every(staticProse));
}
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node)
    .filter(([key]) => !['start', 'end', 'raw', 'comments'].includes(key))
    .map(([key, value]) => [key, normalize(key === 'children' && node.type === 'JSXElement'
      ? value.filter(child => !staticProse(child)) : value)]));
}
export function copyOnly(file, before, after) {
  if (!before || !after || !/^src\/.*\.tsx$/.test(file)) return false;
  try {
    return JSON.stringify(normalize(parseAst(before, { lang: 'tsx' })))
      === JSON.stringify(normalize(parseAst(after, { lang: 'tsx' })));
  } catch { return false; }
}
const visualTags = new Set(['div', 'span', 'section', 'main', 'header', 'footer', 'p', 'strong', 'em', 'small', 'h1', 'h2', 'h3', 'svg', 'rect', 'path', 'circle', 'img']);
const visualAttributes = new Set(['className', 'style', 'title', 'alt', 'aria-label', 'aria-labelledby', 'aria-hidden', 'id', 'width', 'height', 'size', 'viewBox', 'd', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'fill', 'stroke', 'strokeWidth', 'role']);
function visualTree(source) {
  const tree = parseAst(source, { lang: 'tsx' });
  const icons = new Set(tree.body.filter(n => n.type === 'ImportDeclaration' && n.source.value === 'lucide-react').flatMap(n => n.specifiers.map(s => s.local.name)));
  const literal = n => n && (n.type === 'Literal' || n.type === 'StringLiteral' || n.type === 'NumericLiteral' || n.type === 'BooleanLiteral');
  const visit = node => {
    if (Array.isArray(node)) return node.map(visit).filter(n => n !== null);
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'ImportDeclaration' && node.source.value === 'lucide-react') return null;
    if (node.type === 'JSXText') return null;
    if (node.type === 'JSXExpressionContainer' && node.expression.type === 'ConditionalExpression') {
      const e = node.expression;
      const pure = n => ['Identifier', 'Literal'].includes(n.type) || (n.type === 'BinaryExpression' && pure(n.left) && pure(n.right));
      if (literal(e.consequent) && typeof e.consequent.value === 'string' && literal(e.alternate) && typeof e.alternate.value === 'string' && pure(e.test)) return null;
    }
    if (node.type === 'JSXElement') {
      const opening = node.openingElement;
      const attrs = opening.attributes.filter(a => {
        if (a.type !== 'JSXAttribute') return true;
        const value = a.value?.type === 'JSXExpressionContainer' ? a.value.expression : a.value;
        if (visualAttributes.has(a.name.name) && (value === null || literal(value))) return false;
        if (a.name.name === 'src' && literal(value) && /^\/(?:brand[^/]*|favicon|logo)[^?]*\.(?:svg|png|webp)$/.test(value.value)) return false;
        return true;
      });
      if ((visualTags.has(opening.name.name) || icons.has(opening.name.name)) && attrs.length === 0) {
        const children = visit(node.children);
        return children.length ? { type: 'VisualChildren', children } : null;
      }
      return normalize({ ...node, openingElement: { ...opening, attributes: attrs }, children: visit(node.children) });
    }
    return Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'raw', 'comments'].includes(key)).map(([key, value]) => [key, visit(value)]));
  };
  return visit(tree);
}
export function uiOnly(file, before, after) {
  if (!before || !after || !/^src\/.*\.tsx$/.test(file)) return false;
  try { return JSON.stringify(visualTree(before)) === JSON.stringify(visualTree(after)); } catch { return false; }
}
const uiAsset = file => /^src\/.*\.css$/.test(file) || /^(?:public\/(?:brand[^/]*|favicon|logo)[^/]*|src\/assets\/[^.]+)\.(?:svg|png|webp|ico|jpg)$/.test(file);
const controlFiles = new Set(['.github/workflows/frontend-checks.yml', 'scripts/ci/change-scope.mjs', 'scripts/ci/change-scope.test.mjs', 'scripts/performance-budget.mjs', 'tests_ui/performanceBudget.test.ts']);
export function classify(changes, event) {
  if (!['pull_request', 'push'].includes(event) || changes.length === 0) return 'full';
  const document = ({file, before, after}) => /^(README\.md|docs\/.*\.md)$/.test(file)
    || (/^docs\/changes\/[^/]+\.json$/.test(file) && !before && after && JSON.parse(after).kind === 'presentation');
  if (changes.every(row => document(row) || copyOnly(row.file, row.before, row.after))) return 'copy';
  const faviconOnly = row => row.file === 'index.html' && row.before && row.after
    && row.before.replace(/<link\s+rel="icon"[^>]*>/g, '') === row.after.replace(/<link\s+rel="icon"[^>]*>/g, '');
  if (changes.every(row => document(row) || uiAsset(row.file) || faviconOnly(row) || uiOnly(row.file, row.before, row.after) || copyOnly(row.file, row.before, row.after))) return 'ui';
  if (changes.every(row => document(row) || controlFiles.has(row.file))) return 'checks';
  return 'full';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const base = process.env.QUALITY_BASE_REF;
  git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  const read = (ref, file) => { try { return git(['show', `${ref}:${file}`]); } catch { return null; } };
  const changes = git(['diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--']).split('\0').filter(Boolean)
    .map(file => ({ file, before: read(base, file), after: read('HEAD', file) }));
  const scope = classify(changes, process.env.GITHUB_EVENT_NAME);
  console.log(`Checks: ${scope}; ${changes.length} changed files`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
}
