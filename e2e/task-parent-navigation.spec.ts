import { test, expect, type Page, type APIRequestContext } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

type Row = { id: string; title: string };

const detail = (page: Page) =>
  page.getByRole('dialog', { name: '任务详情', exact: true });

async function createTask(
  request: APIRequestContext,
  title: string,
  parentId: string | null = null,
): Promise<Row> {
  const response = await request.post(`${apiUrl}/api/tasks`, {
    data: { title, topicId: null, parentId },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

async function readTask(request: APIRequestContext, id: string) {
  const response = await request.get(
    `${apiUrl}/api/tasks/${id}?includeArchived=true`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

// 让列表只返回子任务，明确验证父任务不在列表中也能导航。
// 详情接口仍走真实服务端。
async function showOnlyChild(page: Page, child: Row) {
  await page.route(/\/api\/tasks(?:\?.*)?$/, async route => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    expect(Array.isArray(payload.data)).toBe(true);
    await route.fulfill({
      response,
      json: {
        ...payload,
        data: payload.data.filter((task: Row) => task.id === child.id),
      },
    });
  });
}

async function openChild(page: Page, child: Row) {
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${child.id}`)
    .getByRole('button', { name: child.title, exact: true })
    .click();
  await expect(detail(page).getByLabel('任务标题', { exact: true }))
    .toHaveValue(child.title);
}

async function resolvedColor(page: Page, variable: string) {
  return detail(page).getByTestId('task-parent-link').evaluate((node, name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    node.appendChild(probe);
    const result = getComputedStyle(probe).color;
    probe.remove();
    return result;
  }, variable);
}

test.beforeEach(async ({ page }) => {
  await resetE2eDatabase();
  await page.addInitScript(() => {
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean })
      .__REACT_GRAB_DISABLED__ = true;
  });
});

test.afterAll(async () => {
  await e2eDatabase.$disconnect();
});

for (const width of [1200, 800, 393]) {
  test(`${width}px：列表没有父任务时仍能跳转，且不改变当前路由`, async ({
    page, request,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    const parent = await createTask(request, '父任务');
    const child = await createTask(request, '子任务', parent.id);
    await showOnlyChild(page, child);

    const writes: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (
        path.startsWith('/api/tasks') &&
        ['POST', 'PATCH', 'DELETE'].includes(request.method())
      ) {
        writes.push(`${request.method()} ${path}`);
      }
    });

    await openChild(page, child);
    await expect(page.getByTestId(`task-row-${parent.id}`)).toHaveCount(0);

    const link = detail(page).getByTestId('task-parent-link');
    await expect(link).toHaveAccessibleName('打开父任务：父任务');
    await expect(link).toHaveAttribute('title', '父任务');

    const beforeUrl = page.url();
    await link.click();

    await expect(detail(page).getByLabel('任务标题', { exact: true }))
      .toHaveValue('父任务');
    await expect(detail(page).getByTestId('task-parent-row')).toHaveCount(0);
    expect(page.url()).toBe(beforeUrl);
    expect(writes).toEqual([]);

    await detail(page).getByRole('button', {
      name: '子任务', exact: true,
    }).click();

    await expect(detail(page).getByLabel('任务标题', { exact: true }))
      .toHaveValue('子任务');
    await expect(detail(page).getByTestId('task-parent-link')).toBeVisible();
  });
}

test('未保存标题：本地草稿安全后直接打开父任务，回来仍能恢复', async ({
  page, request,
}) => {
  const parent = await createTask(request, '父任务');
  const child = await createTask(request, '子任务', parent.id);
  await showOnlyChild(page, child);
  // 按住浏览器里的保存请求，证明离开不等服务端，草稿仍在本地。
  let releasePatch = () => {};
  const held = new Promise<void>((resolve) => { releasePatch = resolve; });
  await page.route(`**/api/tasks/${child.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    await held;
    await route.fallback();
  });
  await openChild(page, child);
  await expect(detail(page).getByTestId('task-parent-link')).toBeVisible();

  await detail(page).getByLabel('任务标题', { exact: true })
    .fill('未保存的新标题');
  await detail(page).getByTestId('task-parent-link').click();

  await expect(page.getByRole('dialog', {
    name: '保存未完成的编辑？', exact: true,
  })).toHaveCount(0);
  await expect(detail(page).getByLabel('任务标题', { exact: true }))
    .toHaveValue('父任务');
  expect((await readTask(request, child.id)).title).toBe('子任务');

  await detail(page).getByRole('button', { name: '子任务', exact: true }).click();
  await expect(detail(page).getByLabel('任务标题', { exact: true }))
    .toHaveValue('未保存的新标题');
  expect((await readTask(request, child.id)).title).toBe('子任务');

  releasePatch();
  await expect.poll(async () => (await readTask(request, child.id)).title)
    .toBe('未保存的新标题');
});

test('父任务 404：显示不可用，不显示可点击入口', async ({
  page, request,
}) => {
  const parent = await createTask(request, '父任务');
  const child = await createTask(request, '子任务', parent.id);
  await showOnlyChild(page, child);

  await page.route(`**/api/tasks/${parent.id}?includeArchived=true`, route =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        data: null, error: '任务不存在', code: 'NOT_FOUND',
      }),
    }),
  );

  await openChild(page, child);
  await expect(detail(page).getByTestId('task-parent-row'))
    .toHaveText('父任务不可用', { timeout: 20_000 });
  await expect(detail(page).getByTestId('task-parent-link')).toHaveCount(0);
  await expect(detail(page).getByLabel('任务标题', { exact: true }))
    .toHaveValue('子任务');
});

test('父任务加载失败后可重试，重试不会跳转', async ({
  page, request,
}) => {
  const parent = await createTask(request, '父任务');
  const child = await createTask(request, '子任务', parent.id);
  await showOnlyChild(page, child);
  let failing = true;

  await page.route(
    `**/api/tasks/${parent.id}?includeArchived=true`,
    async route => {
      if (!failing) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: '测试读取失败' }),
      });
    },
  );

  await openChild(page, child);
  const retry = detail(page).getByRole('button', {
    name: '重新加载父任务', exact: true,
  });
  await expect(retry).toBeVisible({ timeout: 20_000 });

  failing = false;
  await retry.click();

  await expect(detail(page).getByTestId('task-parent-link'))
    .toHaveAccessibleName('打开父任务：父任务');
  await expect(detail(page).getByLabel('任务标题', { exact: true }))
    .toHaveValue('子任务');
});

test('长标题：尺寸固定，单行省略，键盘可以跳转', async ({
  page, request,
}) => {
  await page.setViewportSize({ width: 393, height: 850 });
  const parentTitle = '这是一个很长的父任务标题'.repeat(12);
  const parent = await createTask(request, parentTitle);
  const child = await createTask(request, '子任务', parent.id);
  await showOnlyChild(page, child);
  await openChild(page, child);

  const pane = detail(page);
  const row = pane.getByTestId('task-parent-row');
  const link = pane.getByTestId('task-parent-link');
  const text = pane.getByTestId('task-parent-title');

  await expect(link).toHaveAttribute('title', parentTitle);
  await expect(link).toHaveCSS('height', '32px');
  await expect(link).toHaveCSS('font-size', '13px');
  await expect(link).toHaveCSS('font-weight', '400');
  await expect(link).toHaveCSS('line-height', '20px');
  await expect(text).toHaveCSS('white-space', 'nowrap');
  await expect(text).toHaveCSS('text-overflow', 'ellipsis');
  expect(await text.evaluate(node => node.scrollWidth > node.clientWidth))
    .toBe(true);

  const parentBox = await row.boundingBox();
  const titleBox = await pane.getByTestId('task-detail-title-row').boundingBox();
  expect(parentBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(Math.abs(parentBox!.height - 32)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(titleBox!.y - (parentBox!.y + parentBox!.height) - 4),
  ).toBeLessThanOrEqual(1);

  expect(await pane.evaluate(node => node.scrollWidth <= node.clientWidth))
    .toBe(true);

  await link.focus();
  await expect(link).toBeFocused();
  await link.press('Enter');
  await expect(detail(page).getByLabel('任务标题', { exact: true }))
    .toHaveValue(parentTitle);
});

test('父任务加载中不提供跳转，释放请求后显示名称', async ({ page, request }) => {
  const parent = await createTask(request, '父任务');
  const child = await createTask(request, '子任务', parent.id);
  await showOnlyChild(page, child);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/tasks/${parent.id}?includeArchived=true`, async route => {
    await gate;
    await route.continue().catch(() => undefined);
  });
  try {
    await openChild(page, child);
    const loading = detail(page).getByTestId('task-parent-row');
    await expect(loading).toHaveText('正在加载父任务…');
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(detail(page).getByTestId('task-parent-link')).toHaveCount(0);
  } finally {
    release();
  }
  await expect(detail(page).getByTestId('task-parent-link')).toBeVisible();
});

test('根任务不请求空父 ID', async ({ page, request }) => {
  const root = await createTask(request, '根任务');
  const invalidTaskRequests: string[] = [];
  page.on('request', incoming => {
    const path = new URL(incoming.url()).pathname;
    if (path === '/api/tasks/' || path === '/api/tasks/null' || path === '/api/tasks/undefined') invalidTaskRequests.push(path);
  });
  await page.goto('/#/inbox');
  await page.getByTestId(`task-row-${root.id}`)
    .getByRole('button', { name: '根任务', exact: true })
    .click();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue('根任务');
  await expect(detail(page).getByTestId('task-parent-row')).toHaveCount(0);
  expect(invalidTaskRequests).toEqual([]);
});

test('离开后后台写入子任务标题，不弹保存确认，也不连带改父任务', async ({ page, request }) => {
  const parent = await createTask(request, '父任务');
  const child = await createTask(request, '子任务', parent.id);
  await showOnlyChild(page, child);
  await openChild(page, child);
  await detail(page).getByLabel('任务标题', { exact: true }).fill('修改后的子任务');
  await detail(page).getByTestId('task-parent-link').click();
  await expect(page.getByRole('dialog', { name: '保存未完成的编辑？', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认影响并执行', exact: true })).toHaveCount(0);

  await expect(detail(page).getByLabel('任务标题', { exact: true }))
    .toHaveValue(parent.title);
  await expect.poll(async () => (await readTask(request, child.id)).title).toBe('修改后的子任务');
  expect((await readTask(request, parent.id)).title).toBe(parent.title);
});

test('保存失败时仍打开父任务，回来能恢复草稿且服务端未变', async ({ page, request }) => {
  const parent = await createTask(request, '父任务');
  const child = await createTask(request, '子任务', parent.id);
  await showOnlyChild(page, child);
  await page.route(`**/api/tasks/${child.id}`, async route => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: '保存失败' }),
    });
  });
  await openChild(page, child);
  await detail(page).getByLabel('任务标题', { exact: true }).fill('修改后的子任务');
  const failed = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/tasks/${child.id}`);
  await detail(page).getByTestId('task-parent-link').click();
  expect((await failed).status()).toBe(500);

  await expect(page.getByRole('dialog', {
    name: '保存未完成的编辑？', exact: true,
  })).toHaveCount(0);
  await expect(detail(page).getByLabel('任务标题', { exact: true }))
    .toHaveValue(parent.title);
  expect((await readTask(request, child.id)).title).toBe(child.title);

  await detail(page).getByRole('button', { name: '子任务', exact: true }).click();
  await expect(detail(page).getByLabel('任务标题', { exact: true }))
    .toHaveValue('修改后的子任务');
  expect((await readTask(request, child.id)).title).toBe(child.title);
});

test('键盘 Space 打开父任务', async ({ page, request }) => {
  const parent = await createTask(request, '父任务');
  const child = await createTask(request, '子任务', parent.id);
  await showOnlyChild(page, child);
  await openChild(page, child);
  const link = detail(page).getByTestId('task-parent-link');
  await link.focus();
  await expect(link).toBeFocused();
  await link.press('Space');
  await expect(detail(page).getByLabel('任务标题', { exact: true }))
    .toHaveValue(parent.title);
});

test('归档清单里的只读子任务仍能打开父任务', async ({ page, request }) => {
  await page.setViewportSize({ width: 1200, height: 850 });
  const topicResponse = await request.post(`${apiUrl}/api/topics`, { data: { name: '只读归档清单' } });
  expect(topicResponse.ok(), await topicResponse.text()).toBe(true);
  const topic = (await topicResponse.json()).data as { id: string };
  const parentResponse = await request.post(`${apiUrl}/api/tasks`, { data: { title: '父任务', topicId: topic.id, parentId: null } });
  expect(parentResponse.ok(), await parentResponse.text()).toBe(true);
  const parent = (await parentResponse.json()).data as Row;
  const childResponse = await request.post(`${apiUrl}/api/tasks`, { data: { title: '子任务', topicId: topic.id, parentId: parent.id } });
  expect(childResponse.ok(), await childResponse.text()).toBe(true);
  const child = (await childResponse.json()).data as Row;
  const archived = await request.post(`${apiUrl}/api/topics/${topic.id}/archive`);
  expect(archived.ok(), await archived.text()).toBe(true);

  await page.goto('/#/archived');
  await page.getByRole('button', { name: '只读归档清单', exact: true }).click();
  await page.getByTestId(`task-row-${child.id}`).getByRole('button', { name: '子任务', exact: true }).click();

  await expect(detail(page).getByLabel('任务标题', { exact: true })).toBeDisabled();
  await expect(detail(page).getByTestId('task-parent-link')).toBeEnabled();
  await detail(page).getByTestId('task-parent-link').click();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue(parent.title);
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toBeDisabled();
});

test('切换宽度时未保存的详情还在，也不询问是否离开', async ({ page, request }) => {
  const parent = await createTask(request, '父任务');
  const child = await createTask(request, '子任务', parent.id);
  await showOnlyChild(page, child);
  await page.setViewportSize({ width: 1200, height: 850 });
  await openChild(page, child);
  await detail(page).getByLabel('详情', { exact: true }).fill('尚未保存的详情');
  for (const width of [800, 1200]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(detail(page)).toBeVisible();
    await expect(page.getByRole('dialog', { name: '保存未完成的编辑？', exact: true })).toHaveCount(0);
  }

  await expect(detail(page).getByLabel('详情', { exact: true }))
    .toHaveAttribute('data-value', '尚未保存的详情');
  await expect(page.getByRole('dialog', {
    name: '保存未完成的编辑？', exact: true,
  })).toHaveCount(0);
  expect((await readTask(request, child.id)).description)
    .not.toBe('尚未保存的详情');
});

test('浅色和深色主题使用现有文字颜色', async ({ page, request }) => {
  await page.setViewportSize({ width: 1200, height: 850 });
  const parent = await createTask(request, '父任务');
  const child = await createTask(request, '子任务', parent.id);
  await showOnlyChild(page, child);
  await openChild(page, child);
  const link = detail(page).getByTestId('task-parent-link');
  await expect(link).toBeVisible();

  const choose = async (name: '浅色' | '深色') => {
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
    await page.mouse.move(0, 0);
  };
  const variables = () => page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      muted: style.getPropertyValue('--muted-foreground').trim(),
      foreground: style.getPropertyValue('--foreground').trim(),
      hover: style.getPropertyValue('--glass-hover').trim(),
    };
  });

  await choose('浅色');
  await expect(link).toHaveCSS('color', await resolvedColor(page, '--muted-foreground'));
  expect(await variables()).toEqual({
    muted: '#697487',
    foreground: '#1b2b43',
    hover: '#edf1f8',
  });
  await link.hover();
  await expect(link).toHaveCSS('color', await resolvedColor(page, '--foreground'));

  await choose('深色');
  await expect(link).toHaveCSS('color', await resolvedColor(page, '--muted-foreground'));
  expect(await variables()).toEqual({
    muted: '#a2afc0',
    foreground: '#e8edf5',
    hover: '#26374d',
  });
  await link.hover();
  await expect(link).toHaveCSS('color', await resolvedColor(page, '--foreground'));
});

test('子任务详情不能再添加子任务', async ({ page, request }) => {
  await page.setViewportSize({ width: 1200, height: 850 });
  const parent = await createTask(request, '父任务');
  const child = await createTask(request, '子任务', parent.id);
  await page.goto('/#/inbox');

  await page.getByTestId(`task-row-${parent.id}`)
    .getByRole('button', { name: '父任务', exact: true })
    .click();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue('父任务');
  const section = detail(page).locator('section[aria-label="子任务"]');
  await expect(section).toHaveCount(1);
  await expect(section.getByRole('textbox', { name: '子任务名称', exact: true })).toBeVisible();

  await page.getByTestId(`task-row-${child.id}`)
    .getByRole('button', { name: '子任务', exact: true })
    .click();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue('子任务');
  await expect(detail(page).locator('section[aria-label="子任务"]')).toHaveCount(0);
  await expect(detail(page).getByRole('textbox', { name: '子任务名称', exact: true })).toHaveCount(0);

  await page.getByTestId(`task-row-${child.id}`)
    .getByRole('button', { name: '任务操作：子任务', exact: true })
    .click();
  await expect(page.getByRole('menuitem', { name: '设为子任务', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '添加子任务', exact: true })).toHaveCount(0);
});
