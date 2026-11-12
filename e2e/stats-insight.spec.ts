import { test, expect, type APIRequestContext, type Page } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3015';

test.use({ timezoneId: 'Asia/Shanghai' });

const HEADLINE = '洞察验收：本期完成 1 项任务，新增 2 项。';

function shanghaiDate(daysBack: number) {
  // wall-clock date string in Asia/Shanghai, daysBack=0 is today
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() - daysBack * 86_400_000));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function createTask(request: APIRequestContext, title: string) {
  return (await (await request.post(`${apiUrl}/api/tasks`, { data: { title } })).json()).data as { id: string };
}

async function focusOn(date: string, minutes: number) {
  await e2eDatabase.focusSession.create({
    data: {
      kind: 'focus',
      startedAt: `${date}T09:00`,
      endedAt: `${date}T09:${String(minutes).padStart(2, '0')}`,
      durationMinutes: minutes,
      plannedMinutes: 25,
      completed: true,
      createdAt: new Date().toISOString(),
    },
  });
}

/** One done task + one open task today, focus on the two previous days: exactly 3 recorded days in the 7d range. */
async function seedSevenDayActivity(request: APIRequestContext) {
  await createTask(request, 'E2E 洞察样本');
  const done = await createTask(request, 'E2E 洞察第二项');
  await request.patch(`${apiUrl}/api/tasks/${done.id}`, { data: { status: 'done' } });
  await focusOn(shanghaiDate(1), 25);
  await focusOn(shanghaiDate(2), 25);
}

async function openStats(page: Page) {
  const response = page.waitForResponse((item) => item.url().includes('/api/stats/overview') && item.ok());
  await page.goto('/#/stats');
  await (await response).json();
  await expect(page.getByTestId('stats-page')).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  await resetE2eDatabase();
  await e2eDatabase.focusSession.deleteMany();
  const saved = await request.patch(`${apiUrl}/api/settings`, { data: { baseUrl: 'http://127.0.0.1:4010/v1', model: 'mock-model', apiKey: 'e2e-key' } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(() => {
    (window as unknown as { __REACT_GRAB_DISABLED__?: boolean }).__REACT_GRAB_DISABLED__ = true;
  });
});

test.afterAll(() => e2eDatabase.$disconnect());

test('洞察接口返回分析结论和意见，附生成时间', async ({ request }) => {
  await seedSevenDayActivity(request);
  const response = await request.get(`${apiUrl}/api/stats/insight?${new URLSearchParams({ from: shanghaiDate(6), to: shanghaiDate(0), tz: 'Asia/Shanghai' })}`);
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  expect(body.data.insight).toEqual({
    headline: HEADLINE,
    notes: [
      { tone: 'warn', label: '逾期风险', text: '「E2E 洞察样本」还没完成，先处理它。' },
      { tone: 'idea', label: '建议', text: '把两次专注的节奏排进明天。' },
    ],
  });
  expect(typeof body.data.generatedAt).toBe('string');
  expect(body.data.reason).toBeUndefined();
});

test('统计页横幅显示结论，展开有意见和操作，重新分析回到分析中', async ({ page, request }) => {
  test.setTimeout(60_000);
  await seedSevenDayActivity(request);
  await openStats(page);
  const summary = page.getByTestId('stats-insight-summary');
  await expect(summary).toContainText(HEADLINE);

  await summary.click();
  await expect(page.getByText('逾期风险')).toBeVisible();
  await expect(page.getByText('「E2E 洞察样本」还没完成，先处理它。')).toBeVisible();
  await expect(page.getByText('把两次专注的节奏排进明天。')).toBeVisible();
  await expect(page.getByText(/分析于 \d{2}:\d{2} ·/)).toBeVisible();

  // 重新分析：走 refresh=1，绕过服务端缓存重新生成（mock 秒回，分析中骨架一闪而过，不等它）
  const refreshed = page.waitForResponse((item) => item.url().includes('/api/stats/insight') && item.url().includes('refresh=1') && item.ok());
  await page.getByRole('button', { name: '重新分析' }).click();
  await refreshed;
  await expect(summary).toContainText(HEADLINE);

  // 问工作助手：打开助手并带上结论提示词（放最后，面板会盖住统计页）
  await page.getByRole('button', { name: '问工作助手' }).click();
  await expect.poll(() => page.getByRole('textbox').evaluateAll((nodes) => nodes.some((node) => node instanceof HTMLTextAreaElement && node.value.includes('统计页分析')))).toBe(true);
});

test('空工作区没有横幅', async ({ page }) => {
  await openStats(page);
  await expect(page.getByTestId('stats-insight')).toHaveCount(0);
});

test('模型失败时横幅显示错误和重试', async ({ page, request }) => {
  // 保存接口会先做连通性测试，写不进一个必然失败的模型；直接改库。
  await e2eDatabase.appSetting.updateMany({ data: { openaiModel: 'mock-upstream' } });
  await createTask(request, 'E2E 洞察样本');
  await focusOn(shanghaiDate(1), 25);
  await focusOn(shanghaiDate(2), 25);
  await focusOn(shanghaiDate(3), 25);
  const params = new URLSearchParams({ range: 'custom', from: shanghaiDate(9), to: shanghaiDate(1) });
  const response = page.waitForResponse((item) => item.url().includes('/api/stats/insight') && item.ok());
  await page.goto(`/#/stats?${params.toString()}`);
  await expect(page.getByTestId('stats-page')).toBeVisible();
  await response;
  await expect(page.getByText('这次分析没有完成。')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
});
