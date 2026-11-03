import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('directory lists each account only in its primary department and counts descendants', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { OrganizationDirectory } = await server.ssrLoadModule('/src/components/OrganizationControls.tsx');
    const departments = [
      { id: 'parent', name: '主部门', parent_id: null },
      { id: 'child', name: '子部门', parent_id: 'parent' },
      { id: 'other', name: '兼属部门', parent_id: null },
    ];
    const users = [
      { id: 'a', primary_department_id: 'parent', additional_department_ids: ['child', 'other'] },
      { id: 'b', primary_department_id: 'child', additional_department_ids: ['parent', 'other'] },
      { id: 'c', primary_department_id: null, additional_department_ids: [] },
    ];
    const before = JSON.stringify(users);
    const html = renderToStaticMarkup(createElement(OrganizationDirectory, {
      departments, users, selectedId: 'b', disabled: false,
      onSelect() {}, onDepartment() {}, onDelete() {},
      renderUser: (user: { id: string }) => createElement('span', { 'data-user': user.id }, user.id),
    }));
    for (const user of users) assert.equal(html.split(`data-user="${user.id}"`).length - 1, 1);
    assert.match(html, /title="主部门">主部门<\/strong><small>2<\/small>/);
    assert.match(html, /title="子部门">子部门<\/strong><small>1<\/small>/);
    assert.match(html, /title="兼属部门">兼属部门<\/strong><small>0<\/small>/);
    assert.match(html, /org-unassigned">未分配<\/h4>.*data-user="c"/);
    assert.equal(JSON.stringify(users), before);
  } finally {
    await server.close();
  }
});
