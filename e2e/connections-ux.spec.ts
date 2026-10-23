import type { Locator } from '@playwright/test';
import { test, expect, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

async function owner<T = unknown>(request: APIRequestContext, path: string, input: unknown) {
  const response = await request.post(`${base}${path}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as T;
}

function visibleEdit(scope: Locator) {
  return scope.getByRole('button', { name: '修改授权', exact: true }).filter({ visible: true });
}

function accessScroller(dialog: Locator) {
  return dialog.locator('[class*="max-h-[216px]"]');
}

test('创建连接明确显示必填条件，并在条件满足后可提交', async ({ page }) => {
  await page.goto('/#/connections');

  const open = page.getByRole('button', { name: '创建连接', exact: true });
  await expect(open).toBeEnabled();
  await expect(page.getByText('连接名称（必填）', { exact: true })).toHaveCount(0);
  await open.click();

  const dialog = page.getByRole('dialog');
  const submit = dialog.getByRole('button', { name: '创建并配置宿主', exact: true });
  await expect(dialog.getByText('连接名称（必填）', { exact: true })).toBeVisible();
  await expect(dialog.getByText('请先填写连接名称。', { exact: true })).toBeVisible();
  await expect(submit).toBeDisabled();

  await dialog.getByLabel('连接名称', { exact: true }).fill('我的 Claude Code');
  await dialog.locator('label').filter({ has: page.getByRole('radio', { name: 'Claude Code', exact: true }) }).click();
  await expect(dialog.getByRole('radio', { name: 'Claude Code', exact: true })).toBeChecked();
  await expect(dialog.getByText('请至少选择收集箱或一个清单。', { exact: true })).toBeVisible();
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('允许访问收集箱', { exact: true }).check({ force: true });
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(dialog.getByRole('heading', { name: '把「我的 Claude Code」配置到 Claude Code', exact: true })).toBeVisible();
  await expect(dialog.getByText(/claude mcp add work_with_agent/)).toBeVisible();
  await expect(dialog.getByText(/--scope user --env/)).toBeVisible();
  await expect(dialog.getByText(process.env.E2E_API_URL ?? 'http://127.0.0.1:3015', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/项目绝对路径/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '复制 Claude Code 配置命令', exact: true })).toBeVisible();
  await expect.poll(() => e2eDatabase.connection.count()).toBe(1);
});

test('创建 Grok 连接时给出 grok mcp add 命令，自检配置不回显凭据', async ({ page }) => {
  await page.goto('/#/connections');
  await page.getByRole('button', { name: '创建连接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('连接名称', { exact: true }).fill('我的 Grok');
  await dialog.locator('label').filter({ has: page.getByRole('radio', { name: 'Grok', exact: true }) }).click();
  await expect(dialog.getByRole('radio', { name: 'Grok', exact: true })).toBeChecked();
  await dialog.getByLabel('允许访问收集箱', { exact: true }).check({ force: true });
  await dialog.getByRole('button', { name: '创建并配置宿主', exact: true }).click();

  await expect(dialog.getByRole('heading', { name: '把「我的 Grok」配置到 Grok', exact: true })).toBeVisible();
  await expect(dialog.getByText(/grok mcp add work_with_agent/)).toBeVisible();
  await expect(dialog.getByText(/--scope user/)).toBeVisible();
  await expect(dialog.getByText(/--transport http/)).toBeVisible();
  await expect(dialog.getByText(`${process.env.E2E_API_URL ?? 'http://127.0.0.1:3015'}/mcp`, { exact: false })).toBeVisible();
  await expect(dialog.getByText(/Authorization: Bearer /)).toBeVisible();
  await expect(dialog.getByText('grok mcp list', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '复制 Grok 配置命令', exact: true })).toBeVisible();
  await expect(dialog.getByText(/claude mcp add/)).toHaveCount(0);

  const tokenInput = dialog.getByLabel('连接凭据', { exact: true });
  await expect(tokenInput).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: '显示凭据', exact: true }).click();
  await expect(tokenInput).toHaveAttribute('type', 'text');
  const token = await tokenInput.inputValue();
  expect(token).not.toBe('');

  await dialog.getByRole('button', { name: '我已完成配置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const check = page.getByRole('button', { name: '授权自检与宿主配置', exact: true });
  await expect(check).toHaveAttribute('aria-expanded', 'false');
  await check.click();
  await expect(check).toHaveAttribute('aria-expanded', 'true');
  const panelId = await check.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  const snippet = page.locator(`[id="${panelId}"]`).locator('pre');
  await expect(snippet).toContainText('grok mcp add work_with_agent');
  await expect(snippet).toContainText('--transport http');
  await expect(snippet).toContainText(`${process.env.E2E_API_URL ?? 'http://127.0.0.1:3015'}/mcp`);
  await expect(snippet).toContainText('填入创建时保存的凭据');
  await expect(snippet).not.toContainText(token);
  await expect(snippet).not.toContainText('<paste the credential returned once at creation>');
  await expect.poll(() => e2eDatabase.connection.count()).toBe(1);
});

test('修改授权时宿主锁定，保存后已选清单排在前面', async ({ page, request }) => {
  await owner(request, '/api/topics', { name: '清单甲' });
  await owner(request, '/api/topics', { name: '清单乙' });
  await owner(request, '/api/v1/connections', { name: '办公连接', host: 'claude', topicIds: [], includeInbox: true, autoActions: [] });
  await page.goto('/#/connections');

  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '办公连接', exact: true }) });
  await visibleEdit(card).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '修改连接：办公连接', exact: true })).toBeVisible();
  await expect(dialog.getByText('换宿主请新建连接', { exact: true })).toBeVisible();
  for (const name of ['Codex', 'Claude Code', 'Grok']) {
    await expect(dialog.getByRole('radio', { name, exact: true })).toBeDisabled();
  }

  const checks = accessScroller(dialog).getByRole('checkbox');
  await expect(checks).toHaveCount(2);
  const firstLabel = (await checks.nth(0).getAttribute('aria-label')) ?? '';
  const secondLabel = (await checks.nth(1).getAttribute('aria-label')) ?? '';
  expect(firstLabel.startsWith('允许访问清单：')).toBe(true);
  expect(secondLabel.startsWith('允许访问清单：')).toBe(true);
  const selectedName = secondLabel.slice('允许访问清单：'.length);
  await checks.nth(1).check();
  await dialog.getByRole('button', { name: '保存授权范围', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const access = card.locator('dt', { hasText: '可访问' }).locator('xpath=following-sibling::dd[1]');
  await expect(access).toContainText(selectedName);

  await visibleEdit(card).click();
  const reopened = page.getByRole('dialog');
  const reopenedChecks = accessScroller(reopened).getByRole('checkbox');
  await expect(reopenedChecks.nth(0)).toHaveAttribute('aria-label', secondLabel);
  await expect(reopenedChecks.nth(0)).toBeChecked();
  await expect(reopenedChecks.nth(1)).toHaveAttribute('aria-label', firstLabel);
  await expect(reopenedChecks.nth(1)).not.toBeChecked();
});

test('撤销连接需确认，取消后保持原样，确认后进入已撤销', async ({ page, request }) => {
  await owner(request, '/api/v1/connections', { name: '要撤销的连接', host: 'codex', topicIds: [], includeInbox: true, autoActions: [] });
  await page.goto('/#/connections');
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '要撤销的连接', exact: true }) });

  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '撤销连接…', exact: true }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('heading', { name: '撤销「要撤销的连接」？', exact: true })).toBeVisible();
  await expect(confirm.getByRole('button', { name: '撤销连接', exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(visibleEdit(card)).toBeVisible();
  await expect(page.getByRole('button', { name: /已撤销/ })).toHaveCount(0);
  expect((await e2eDatabase.connection.findFirstOrThrow()).status).toBe('active');

  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '撤销连接…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '撤销连接', exact: true }).click();
  const revokedToggle = page.getByRole('button', { name: /已撤销 1 个/ });
  await expect(revokedToggle).toBeVisible();
  await revokedToggle.click();
  const revokedPanel = page.locator('[data-slot="collapsible-content"]');
  await expect(revokedPanel.getByRole('heading', { name: '要撤销的连接', exact: true })).toBeVisible();
  await expect(revokedPanel.getByRole('button', { name: '修改授权', exact: true })).toHaveCount(0);
});

test('授权清单被删除后显示授权异常，取消勾选失效清单后才能保存', async ({ page, request }) => {
  const topic = await owner<{ id: string }>(request, '/api/topics', { name: '会消失的清单' });
  await owner(request, '/api/v1/connections', { name: '异常连接', host: 'claude', topicIds: [topic.id], includeInbox: true, autoActions: [] });
  await page.goto('/#/connections');
  await e2eDatabase.topic.delete({ where: { id: topic.id } });
  await page.reload();

  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '异常连接', exact: true }) });
  await expect(card.getByText('授权异常', { exact: true })).toBeVisible();
  await expect(card.getByText('有 1 个授权清单已不存在，宿主访问它会失败。请修改授权移除它。', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '修改授权，移除失效清单', exact: true }).click();

  const dialog = page.getByRole('dialog');
  const missing = dialog.getByRole('checkbox', { name: '允许访问清单：已删除的清单', exact: true });
  await expect(missing).toBeChecked();
  await expect(dialog.getByLabel('允许访问收集箱', { exact: true })).toBeChecked();
  const save = dialog.getByRole('button', { name: '保存授权范围', exact: true });
  await expect(save).toBeDisabled();
  await missing.uncheck();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card.getByText('等待首次调用', { exact: true })).toBeVisible();
  await expect(card.getByText('授权异常', { exact: true })).toHaveCount(0);
});

test('允许访问可搜索，全选只勾选筛出的清单', async ({ page, request }) => {
  for (let index = 1; index <= 16; index += 1) {
    await owner(request, '/api/topics', { name: `普通清单${String(index).padStart(2, '0')}` });
  }
  await owner(request, '/api/topics', { name: '海盐甲' });
  await owner(request, '/api/topics', { name: '海盐乙' });
  await page.goto('/#/connections');
  await page.getByRole('button', { name: '创建连接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const scroller = accessScroller(dialog);
  await expect.poll(() => scroller.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);

  await dialog.getByLabel('搜索清单', { exact: true }).fill('海盐');
  await expect(scroller.getByRole('checkbox')).toHaveCount(2);
  await expect(dialog.getByRole('checkbox', { name: '允许访问清单：普通清单01', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: '允许访问清单：海盐甲', exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: '允许访问清单：海盐乙', exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: '全选', exact: true }).click();
  await expect(dialog.getByLabel('允许访问收集箱', { exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: '允许访问清单：海盐甲', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: '允许访问清单：海盐乙', exact: true })).toBeChecked();

  await dialog.getByLabel('搜索清单', { exact: true }).fill('');
  await expect(dialog.getByRole('checkbox', { name: '允许访问清单：普通清单01', exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: '已选 2', exact: true }).click();
  await expect(scroller.getByRole('checkbox')).toHaveCount(2);
  await expect(dialog.getByRole('checkbox', { name: '允许访问清单：海盐甲', exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: '允许访问清单：海盐乙', exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: '允许访问清单：普通清单01', exact: true })).toHaveCount(0);
});

test('有调用记录的连接显示已连接，没有的显示等待首次调用', async ({ page, request }) => {
  await owner(request, '/api/v1/connections', { name: '尚未调用', host: 'codex', topicIds: [], includeInbox: true, autoActions: [] });
  const connected = await owner<{ id: string }>(request, '/api/v1/connections', { name: '已经调用', host: 'grok', topicIds: [], includeInbox: true, autoActions: [] });
  await e2eDatabase.requestReceipt.create({
    data: {
      actorId: `connection:${connected.id}`,
      requestId: 'e2e-connections-ux',
      requestHash: 'e2e-connections-ux',
      response: '{}',
      createdAt: new Date().toISOString(),
    },
  });
  await page.goto('/#/connections');

  const connectedCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '已经调用', exact: true }) });
  const waitingCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '尚未调用', exact: true }) });
  await expect(connectedCard.getByText('已连接', { exact: true })).toBeVisible();
  await expect(waitingCard.getByText('等待首次调用', { exact: true })).toBeVisible();
  await expect(connectedCard.getByText('等待首次调用', { exact: true })).toHaveCount(0);
  await expect(waitingCard.getByText('已连接', { exact: true })).toHaveCount(0);
});

test('没有连接时可以从空状态预选 Grok', async ({ page }) => {
  await page.goto('/#/connections');
  await expect(page.getByRole('button', { name: '连接 Codex', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '连接 Claude Code', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '连接 Grok', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '连接 Grok', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '创建连接', exact: true })).toBeVisible();
  const grok = dialog.getByRole('radio', { name: 'Grok', exact: true });
  await expect(grok).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'Codex', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'Claude Code', exact: true })).not.toBeChecked();
});
