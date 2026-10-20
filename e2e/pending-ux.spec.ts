import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const base = 'http://127.0.0.1:3015';

async function owner(request: APIRequestContext, path: string, input: unknown) {
  const response = await request.post(`${base}${path}`, { data: input });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

async function connection(token: string, path: string, input?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const body = await response.json();
  expect(response.ok, JSON.stringify(body)).toBe(true);
  return body.data;
}

async function link(request: APIRequestContext, name: string, topicIds: string[] = []) {
  return owner(request, '/api/v1/connections', { name, host: 'codex', topicIds, includeInbox: true, autoActions: [] });
}

async function submit(token: string, commands: unknown[]) {
  const data = await connection(token, '/api/v1/commands', { requestId: crypto.randomUUID(), commands });
  expect(data.status).toBe('pending_approval');
  return data as { proposalId: string; proposalRevision: number; status: string };
}

test.beforeEach(resetE2eDatabase);
test.afterAll(() => e2eDatabase.$disconnect());

function cards(page: Page) {
  return page.getByTestId('proposal-card');
}

async function openProposals(page: Page) {
  await page.goto('/#/proposals');
  await expect(page.getByRole('heading', { name: '待确认', exact: true })).toBeVisible();
}

test('记忆提案显示类型、标签和依据，页面没有对象原文', async ({ page, request }) => {
  const topic = await owner(request, '/api/topics', { name: '依据清单' });
  const task = await owner(request, '/api/tasks', { title: '依据里的任务', topicId: topic.id });
  const access = await link(request, '记忆连接', [topic.id]);
  await submit(access.token, [{
    kind: 'memory.create',
    input: {
      topicId: topic.id,
      kind: 'question',
      title: '要不要分页',
      content: '列表接口还没决定分页方式。',
      evidence: [{ type: 'task', id: task.id, revision: task.revision }],
      importance: 2,
      labels: ['接口', '分页'],
      reason: '任务里留下了未决问题',
    },
  }]);
  await openProposals(page);
  const card = cards(page);
  await expect(card).toHaveCount(1);
  await expect(card.getByText('未决问题', { exact: true })).toBeVisible();
  await expect(card.getByText('接口', { exact: true })).toBeVisible();
  await expect(card.getByText('分页', { exact: true })).toBeVisible();
  await expect(card).toContainText('依据里的任务');
  await expect(card).toContainText('依据清单');
  await expect(card).toContainText('待办');
  await expect(page.getByRole('main')).not.toContainText('[object Object]');
});

test('派发学习来源显示技能名', async ({ page }) => {
  const now = new Date().toISOString();
  const name = 'dispatch-checklist-e2e';
  await e2eDatabase.proposal.create({
    data: {
      actorId: 'orchestration-learning',
      commands: JSON.stringify([{ kind: 'skill.create', input: { name, description: '派发前先核对仓库', instructions: '先检查工作区是否干净。', reason: '反复出现合入失败' } }]),
      preconditions: JSON.stringify({ actor: { id: 'orchestration-learning', kind: 'internal', topicIds: 'all', includeInbox: true, autoActions: [], revision: 1 } }),
      preview: JSON.stringify([{ detail: { kind: 'skill.create', name }, after: null }]),
      createdAt: now,
      updatedAt: now,
    },
  });
  await openProposals(page);
  const card = cards(page);
  await expect(card).toContainText('派发学习');
  await expect(card).toContainText(name);
});

test('整组四项说明依赖并在确认后落库', async ({ page, request }) => {
  const topic = await owner(request, '/api/topics', { name: '整组清单' });
  const existing = await owner(request, '/api/tasks', { title: '待推进的任务', topicId: topic.id });
  const access = await link(request, '整组连接', [topic.id]);
  await submit(access.token, [
    { kind: 'task.create', clientRef: 'parent', input: { title: '父任务甲', topicId: topic.id } },
    { kind: 'task.create', clientRef: 'child-a', input: { title: '子任务乙', parentId: { $ref: 'parent' } } },
    { kind: 'task.create', clientRef: 'child-b', input: { title: '子任务丙', parentId: { $ref: 'parent' } } },
    { kind: 'task.update', targetId: existing.id, expectedRevision: existing.revision, input: { status: 'doing' } },
  ]);
  await openProposals(page);
  const card = cards(page);
  await expect(card).toContainText('第 2、3 项是第 1 项的子任务');
  await expect(card).toContainText('只能整组确认或整组拒绝');
  for (const mark of ['①', '②', '③', '④']) await expect(card).toContainText(mark);
  await expect(card).toContainText('父任务甲');
  await expect(card).toContainText('子任务乙');
  await expect(card).toContainText('子任务丙');
  await expect(card).not.toContainText('删除');
  await card.getByRole('button', { name: '确认这一组（4 项）', exact: true }).click();
  await expect.poll(async () => {
    const parent = await e2eDatabase.task.findFirst({ where: { title: '父任务甲' } });
    const childA = await e2eDatabase.task.findFirst({ where: { title: '子任务乙' } });
    const childB = await e2eDatabase.task.findFirst({ where: { title: '子任务丙' } });
    const updated = await e2eDatabase.task.findUnique({ where: { id: existing.id } });
    return Boolean(parent && childA?.parentId === parent.id && childB?.parentId === parent.id && updated?.status === 'doing');
  }).toBe(true);
  expect(await e2eDatabase.task.count()).toBe(4);
});

test('编辑后才出现输入框，保存会升版本，取消会还原标题', async ({ page, request }) => {
  const task = await owner(request, '/api/tasks', { title: '原标题' });
  const access = await link(request, '编辑连接');
  const proposal = await submit(access.token, [{ kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { title: '建议标题', priority: 'low' } }]);
  await openProposals(page);
  const card = cards(page);
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await expect(card.getByRole('combobox')).toHaveCount(0);
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(card).toContainText('正在编辑');
  await card.getByRole('combobox', { name: '优先级' }).click();
  await page.getByRole('option', { name: '高', exact: true }).click();
  await card.getByRole('button', { name: '保存并重新预览', exact: true }).click();
  await expect.poll(async () => {
    const row = await e2eDatabase.proposal.findUniqueOrThrow({ where: { id: proposal.proposalId } });
    const commands = JSON.parse(row.commands) as Array<{ input: { priority?: string } }>;
    return { revision: row.revision, priority: commands[0]?.input.priority };
  }).toEqual({ revision: 2, priority: 'high' });
  await expect(card.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await card.getByRole('textbox', { name: '标题' }).fill('临时标题');
  await card.getByRole('button', { name: '取消', exact: true }).click();
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await expect(card).toContainText('建议标题');
  await expect(card).not.toContainText('临时标题');
  const saved = JSON.parse((await e2eDatabase.proposal.findUniqueOrThrow({ where: { id: proposal.proposalId } })).commands) as Array<{ input: { title?: string; priority?: string } }>;
  expect(saved[0]?.input.title).toBe('建议标题');
  expect(saved[0]?.input.priority).toBe('high');
});

test('拒绝快捷理由写入结果，并在已拒绝分段显示', async ({ page, request }) => {
  const task = await owner(request, '/api/tasks', { title: '可能重复的任务' });
  const access = await link(request, '拒绝连接');
  const proposal = await submit(access.token, [{ kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { title: '另一条标题' } }]);
  await openProposals(page);
  const card = cards(page);
  await card.getByRole('button', { name: '拒绝', exact: true }).click();
  await card.getByRole('button', { name: '重复了', exact: true }).click();
  await card.getByRole('button', { name: '确认拒绝', exact: true }).click();
  await expect.poll(async () => {
    const row = await e2eDatabase.proposal.findUniqueOrThrow({ where: { id: proposal.proposalId } });
    const reason = row.result ? String(JSON.parse(row.result).reason ?? '') : '';
    return row.status === 'rejected' && reason.includes('重复了');
  }).toBe(true);
  await page.getByRole('tab', { name: '已拒绝', exact: true }).click();
  await expect(cards(page)).toContainText('拒绝理由：重复了');
});

test('确认过期提议时卡片自己显示冲突', async ({ page, request }) => {
  const task = await owner(request, '/api/tasks', { title: '会被别人先改的任务' });
  const access = await link(request, '冲突连接');
  const proposal = await submit(access.token, [{ kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { title: '晚到的标题' } }]);
  await openProposals(page);
  const card = cards(page);
  await expect(card).toHaveAttribute('data-state', 'pending');
  await e2eDatabase.proposal.update({ where: { id: proposal.proposalId }, data: { revision: { increment: 1 } } });
  await card.getByRole('button', { name: '确认', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'error');
  await expect(card).toContainText('提议已处理或发生变化');
  await expect(card.getByRole('button', { name: '刷新', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '确认', exact: true })).toBeDisabled();
});

test('批量确认时一条成功，冲突的那条留在卡片上', async ({ page, request }) => {
  const access = await link(request, '批量连接');
  const first = await owner(request, '/api/tasks', { title: '批量甲' });
  const second = await owner(request, '/api/tasks', { title: '批量乙' });
  const ok = await submit(access.token, [{ kind: 'task.update', targetId: first.id, expectedRevision: first.revision, input: { title: '批量甲已确认' } }]);
  const bad = await submit(access.token, [{ kind: 'task.update', targetId: second.id, expectedRevision: second.revision, input: { title: '批量乙已确认' } }]);
  await openProposals(page);
  await expect(cards(page)).toHaveCount(2);
  await e2eDatabase.proposal.update({ where: { id: bad.proposalId }, data: { revision: { increment: 1 } } });
  await cards(page).nth(0).getByRole('checkbox').check();
  await cards(page).nth(1).getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认所选', exact: true }).click();
  await expect.poll(async () => (await e2eDatabase.proposal.findUniqueOrThrow({ where: { id: ok.proposalId } })).status).toBe('executed');
  await expect.poll(async () => (await e2eDatabase.task.findUniqueOrThrow({ where: { id: first.id } })).title).toBe('批量甲已确认');
  const failed = cards(page).filter({ hasText: '批量乙' });
  await expect(failed).toHaveAttribute('data-state', 'error');
  await expect(failed).toContainText('提议已处理或发生变化');
  const bar = page.getByRole('region').filter({ has: page.getByRole('button', { name: '确认所选', exact: true }) });
  await expect(bar).toContainText('成功 1');
  await expect(bar).toContainText('失败 1');
});

test('侧栏和更多页显示待确认数量', async ({ page, request, isMobile }) => {
  const access = await link(request, '数量连接');
  const first = await owner(request, '/api/tasks', { title: '数量甲' });
  const second = await owner(request, '/api/tasks', { title: '数量乙' });
  await submit(access.token, [{ kind: 'task.update', targetId: first.id, expectedRevision: first.revision, input: { title: '数量甲新' } }]);
  await submit(access.token, [{ kind: 'task.update', targetId: second.id, expectedRevision: second.revision, input: { title: '数量乙新' } }]);
  if (isMobile) {
    await page.goto('/#/more');
    const row = page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '待确认', exact: true });
    await expect(row.locator('[data-count]')).toHaveAttribute('data-count', '2');
  } else {
    await page.goto('/#/inbox');
    const linkButton = page.getByRole('navigation', { name: '工作' }).getByRole('button', { name: '待确认', exact: true });
    await expect(linkButton.locator('[data-count]')).toHaveAttribute('data-count', '2');
  }
});

test('类型和来源筛选只留下对应卡片', async ({ page, request, isMobile }) => {
  const topic = await owner(request, '/api/topics', { name: '筛选清单' });
  const task = await owner(request, '/api/tasks', { title: '筛选用任务', topicId: topic.id });
  const taskLink = await link(request, '任务连接', [topic.id]);
  const memoryLink = await link(request, '记忆连接', [topic.id]);
  await submit(taskLink.token, [{ kind: 'task.update', targetId: task.id, expectedRevision: task.revision, input: { priority: 'high' } }]);
  await submit(memoryLink.token, [{
    kind: 'memory.create',
    input: {
      topicId: topic.id,
      kind: 'question',
      title: '要不要分页',
      content: '筛选用的记忆正文。',
      evidence: [{ type: 'task', id: task.id, revision: task.revision }],
      importance: 2,
      labels: ['筛选'],
    },
  }]);
  await openProposals(page);
  await expect(cards(page)).toHaveCount(2);
  const types = page.getByRole('group', { name: '按类型' });
  await types.getByRole('button', { name: '记忆 1', exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).getByRole('heading', { name: '保存记忆', exact: true })).toBeVisible();
  await expect(cards(page)).toContainText('要不要分页');
  await expect(cards(page).getByRole('heading', { name: '修改任务「筛选用任务」', exact: true })).toHaveCount(0);
  await types.getByRole('button', { name: '全部 2', exact: true }).click();
  await expect(cards(page)).toHaveCount(2);
  if (isMobile) {
    await page.getByRole('combobox', { name: '来源' }).click();
    await page.getByRole('option', { name: '任务连接 1', exact: true }).click();
  } else {
    await page.getByRole('group', { name: '按来源' }).getByRole('button', { name: '任务连接 1', exact: true }).click();
  }
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).getByRole('heading', { name: '修改任务「筛选用任务」', exact: true })).toBeVisible();
  await expect(cards(page)).not.toContainText('要不要分页');
});
