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
export function classify(changes, event) {
  if (!['pull_request', 'push'].includes(event) || changes.length === 0) return 'full';
  return changes.every(({ file, before, after }) =>
    (/^(README\.md|docs\/.*\.md)$/.test(file))
    || (/^docs\/changes\/[^/]+\.json$/.test(file) && !before && after && JSON.parse(after).kind === 'presentation')
    || copyOnly(file, before, after)) ? 'copy' : 'full';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = args => execFileSync('git', args, { encoding: 'utf8' });
  const base = process.env.QUALITY_BASE_REF;
  git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  const read = (ref, file) => { try { return git(['show', `${ref}:${file}`]); } catch { return null; } };
  const changes = git(['diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--']).split('\0').filter(Boolean)
    .map(file => ({ file, before: read(base, file), after: read('HEAD', file) }));
  const scope = classify(changes, process.env.GITHUB_EVENT_NAME);
  console.log(`Checks: ${scope}; ${changes.length} changed files`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
}
