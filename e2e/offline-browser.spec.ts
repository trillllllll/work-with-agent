import { test, expect } from './fixtures.js';
import { e2eDatabase, resetE2eDatabase } from './database.js';

const api = process.env.E2E_API_URL!;
const fault = (offline: boolean) => fetch(`http://127.0.0.1:${Number(new URL(api).port) + 2}/${offline ? 'offline' : 'online'}`, { method: 'POST' });
test.beforeEach(async () => { await fault(false); await resetE2eDatabase(); });
test.afterEach(() => fault(false));
test.afterAll(() => e2eDatabase.$disconnect());

test('offline create, completion and reload survive and converge without duplicate tasks', async ({ page, context, request }, info) => {
  const errors: string[] = []; let outageStarted = false;
  page.on('pageerror', error => {
    // WebKit reports a caught failed Fetch as a page error during the deliberate
    // socket outage. Keep JavaScript errors and failures outside that test fault.
    if (info.project.name === 'webkit' && outageStarted && /Fetch API cannot load http:\/\/127\.0\.0\.1:\d+\/api\//.test(error.stack ?? '')) return;
    errors.push(error.message);
  });
  await page.goto('/#/inbox');
  await expect(page.getByRole('textbox', { name: '收集任务名称', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  const simulateRadioOffline = info.project.name !== 'webkit';
  outageStarted = true;
  if (simulateRadioOffline) await context.setOffline(true); else await fault(true);
  const capture = page.getByRole('textbox', { name: '收集任务名称', exact: true });
  await capture.fill('离线新增并完成'); await capture.press('Enter');
  const row = page.getByTestId(/^task-row-/).filter({ hasText: '离线新增并完成' });
  await expect(row).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /离线使用|已保存在此设备|同步暂不可用/ })).toBeVisible();
  const id = (await row.getAttribute('data-testid'))!.replace('task-row-', '');
  await row.getByRole('checkbox', { name: '完成任务：离线新增并完成', exact: true }).click();
  await expect(page.getByText('已完成 · 1', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '收集箱', exact: true })).toBeVisible();
  await page.getByText('已完成 · 1', { exact: true }).click();
  await expect(page.getByTestId(`task-row-${id}`).getByRole('checkbox', { name: '重开任务：离线新增并完成', exact: true })).toBeChecked();
  if (simulateRadioOffline) await context.setOffline(false); else await fault(false);
  await expect.poll(async () => {
    const result = await request.get(`${api}/api/tasks/${id}`);
    return result.ok() ? (await result.json()).data.status : null;
  }, { timeout: 25_000 }).toBe('done');
  await expect.poll(async () => (await (await request.get(`${api}/api/tasks?status=all`)).json()).data.filter((task: any) => task.id === id).length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: /条修改待同步/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('online handoff reads a real hub revision instead of the synthetic replica revision', async ({ page, request }) => {
  const created = (await (await request.post(`${api}/api/tasks`, { data: { title: '交接版本校验' } })).json()).data;
  for (let n = 0; n < 3; n++) await request.patch(`${api}/api/tasks/${created.id}`, { data: { description: `第${n}次编辑` } });
  await page.goto('/#/inbox');
  await expect(page.getByTestId(`task-row-${created.id}`)).toBeVisible();
  const result = await page.evaluate(async taskId => {
    // Confirm that this task really has a local version distinct from the server version.
    const runtimeDatabase = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('dovun-workspace-replicas', 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const replicas = await new Promise<any[]>(resolve => { const tx = runtimeDatabase.transaction('replicas'); const r = tx.objectStore('replicas').getAll(); tx.oncomplete = () => resolve(r.result); });
    runtimeDatabase.close();
    return { revision: replicas[0].rows.task[taskId].revision, outbox: replicas[0].outbox.length };
  }, created.id);
  expect(result.outbox).toBe(0);
  expect((await (await request.get(`${api}/api/tasks/${created.id}`)).json()).data.revision).toBeGreaterThan(result.revision);
  await page.getByTestId(`task-row-${created.id}`).getByRole('button', { name: '任务操作：交接版本校验', exact: true }).click();
  await page.getByRole('menuitem', { name: '交给 AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '交给 AI', exact: true });
  await dialog.getByLabel('交接目标与约束', { exact: true }).fill('只准备交接，核对版本，不启动执行');
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/handoffs' && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '准备交接', exact: true }).click();
  expect((await response).ok(), await (await response).text()).toBe(true);
  await expect.poll(async () => (await (await request.get(`${api}/api/v1/handoffs?taskId=${created.id}`)).json()).data.length).toBe(1);
});

test('downloaded attachments stay available offline and never cross workspace scopes', async ({page,request})=>{
  const task=(await (await request.post(`${api}/api/tasks`,{data:{title:'离线附件校验'}})).json()).data;
  // JPEG signature is validated by this endpoint; file bytes are deliberately tiny fixture data.
  const image=(await (await request.post(`${api}/api/tasks/${task.id}/images`,{data:{attachmentBase64:Buffer.from([255,216,255,217]).toString('base64'),mimeType:'image/jpeg'}})).json()).data;
  await page.goto('/#/inbox');
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller) await new Promise<void>(r=>navigator.serviceWorker.addEventListener('controllerchange',()=>r(),{once:true}));});
  const read=(url:string)=>page.evaluate(async url=>{const r=await fetch(url);return {status:r.status,offline:r.headers.get('X-Dovun-Offline'),cached:r.headers.get('X-Dovun-Offline-Available'),bytes:Array.from(new Uint8Array(await r.arrayBuffer()))};},url);
  await expect.poll(async()=>(await read(image.url)).cached).toBe('1');
  await fault(true);
  const saved=await read(image.url);expect(saved.status).toBe(200);expect(saved.offline).toBe('1');expect(saved.bytes).toEqual([255,216,255,217]);
  expect((await read(`/api/tasks/${task.id}/images/never-downloaded`)).status).toBe(503);
  await page.evaluate(()=>navigator.serviceWorker.controller!.postMessage({type:'dovun-offline-scope',scope:'another-workspace-and-actor'}));
  await expect.poll(async()=>(await read(image.url)).status).toBe(503);
  await fault(false);
});
