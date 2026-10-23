// Run from the repository: node docs/design/dovun/prototype/verify.mjs
// Uses the existing Playwright and sharp dependencies. No application service or database.
import { chromium } from 'playwright';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const evidence = join(root, 'evidence');
await mkdir(evidence, { recursive: true });
const url = pathToFileURL(join(root, 'index.html')).href;
const browser = await chromium.launch({ headless: true });
const errors = [], failedRequests = [], checks = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
page.on('requestfailed', r => failedRequests.push(r.url()));
page.on('request', r => { if (/^https?:/.test(r.url())) errors.push(`Unexpected external request: ${r.url()}`); });
const check = (name) => checks.push(name);
const nav = async view => {
  await page.locator(`.sidebar [data-nav="${view}"]`).first().click();
  await page.locator('#main h1').waitFor();
};
const screenshot = name => page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

try {
  await page.goto(url);
  await page.locator('.task-row').first().waitFor();
  await noOverflow();
  await screenshot('today-desktop-light');
  assert.equal(await page.locator('details[data-advanced]').getAttribute('open'), null);
  check('Today is the default; advanced navigation starts collapsed.');

  await page.locator('[data-form="task"] input').fill('样板验收任务');
  await page.locator('[data-form="task"]').evaluate(form => form.requestSubmit());
  await page.getByRole('button', {name:'样板验收任务', exact:false}).click();
  await page.locator('#detail-title').fill('编辑后的样板验收任务');
  await page.locator('#detail-description').fill('草稿在关闭和重新打开后仍然保留。');
  await page.locator('#detail-date').fill('2026-10-23T14:00');
  await page.locator('[role=dialog] [data-action="close-modal"]').click();
  await page.getByRole('button',{name:'编辑后的样板验收任务',exact:false}).click();
  assert.equal(await page.locator('#detail-description').inputValue(), '草稿在关闭和重新打开后仍然保留。');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button',{name:'编辑后的样板验收任务',exact:false}).waitFor();
  check('Capture, edit, close, reopen and reload preserve the demo task and draft.');

  await page.getByRole('checkbox',{name:'编辑后的样板验收任务',exact:true}).check();
  assert.equal(await page.locator('.task-row.done').count(),2);
  check('Task completion updates the list.');

  await nav('library');
  await page.locator('[data-control="material-query"]').fill('矢量稿');
  assert.equal(await page.locator('.material-row').count(),1);
  await page.locator('[data-control="material-query"]').fill('');
  await page.locator('[data-filter="links"]').click();
  assert.equal(await page.locator('.material-row').count(),1);
  await page.locator('[data-filter="all"]').click();
  await page.locator('[data-action="add-material"]').click();
  await page.locator('#material-title').fill('样板资料');
  await page.locator('#material-body').fill('仅用于验证样板交互。');
  await page.locator('[form="material-form"]').click();
  await page.getByRole('button',{name:'样板资料',exact:false}).click();
  assert.match(await page.locator('.source-copy').innerText(),/验证样板交互/);
  await page.keyboard.press('Escape');
  check('Library search, type filtering, add and source preview work.');
  await screenshot('library-desktop-light');

  await nav('knowledge');
  await page.locator('[data-context-tab="memories"]').click();
  assert.equal(await page.locator('.memory-row').count(),2);
  await page.locator('.memory-row [data-material="design"]').first().click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[data-context-tab="fixed"]').click();
  await page.locator('[data-context-tab="brief"]').click();
  await screenshot('knowledge-desktop-light');
  check('Brief, confirmed memories, working instructions and source links are distinct.');

  await nav('today');
  await page.locator('[data-task="brand"]').click();
  await screenshot('task-detail-desktop-light');
  await page.locator('[data-action="task-assistant"]').click();
  assert.match(await page.locator('.assistant-scope').innerText(),/整理个人工作台的视觉样板/);
  await page.locator('[data-suggestion="suggestion1"]').click();
  await page.locator('.assistant [data-action="accept"]').click();
  await page.locator('.topbar [data-action="assistant"]').click();
  await page.locator('[data-task="icon"]').click();
  assert.equal(await page.locator('#detail-date').inputValue(),'2026-10-23T15:00');
  await page.keyboard.press('Escape');
  check('Task-scoped assistant makes a simulated proposal; accepting updates only the demo schedule.');

  await nav('plan');
  assert.equal(await page.locator('.day-column').count(),7);
  assert.equal(await page.locator('.event[data-task="icon"]').count(),1);
  await screenshot('plan-desktop-light');
  const dateBefore=await page.locator('.day-number').first().innerText();
  await page.locator('[data-action="next"]').click();
  assert.notEqual(await page.locator('.day-number').first().innerText(),dateBefore);
  assert.equal(await page.locator('.event').count(),0);
  await page.locator('[data-action="previous"]').click();
  await page.locator('[data-plan-mode="day"]').click();
  assert.equal(await page.locator('.day-column').count(),1);
  check('Plan renders seven days, date navigation and a day view from demo task schedules.');

  await nav('today');
  const longTitle='W'.repeat(200);
  await page.locator('[data-form="task"] input').fill(longTitle);
  await page.locator('[data-form="task"]').evaluate(form=>form.requestSubmit());
  await page.setViewportSize({width:390,height:844});
  await noOverflow();
  await page.locator('.mobile-nav [data-nav="plan"]').click();
  await noOverflow();
  await page.locator('.mobile-nav [data-nav="today"]').click();
  await page.locator('.task-open').filter({hasText:longTitle}).click();
  await page.locator('#detail-date').fill('2026-10-24T20:00');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.task-open').filter({hasText:longTitle}).count(),0);
  await page.setViewportSize({width:1440,height:1000});
  await nav('plan');
  await page.locator('[data-plan-mode="week"]').click();
  await page.setViewportSize({width:390,height:844});
  await noOverflow();
  await page.getByRole('button',{name:longTitle,exact:false}).click();
  assert.equal(await page.locator('#detail-date').inputValue(),'2026-10-24T20:00');
  await page.locator('#detail-date').fill('2026-10-21T20:00');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:1000});
  await nav('today');
  const movedRow=page.locator('.task-row').filter({hasText:longTitle});
  assert.equal(await movedRow.locator('.time-label.overdue').count(),1);
  await movedRow.locator('.task-open').click();
  await page.locator('#detail-title').fill('已核对长标题和日期边界');
  await page.keyboard.press('Escape');
  check('Long unbroken titles fit 390px; future tasks leave Today, past tasks become overdue, and evening schedules stay reachable.');

  const rejectPage=await context.newPage();
  await rejectPage.goto(url);
  await rejectPage.locator('.topbar [data-action="assistant"]').click();
  await rejectPage.locator('[data-suggestion="suggestion1"]').click();
  await rejectPage.locator('.assistant [data-action="reject"]').click();
  await rejectPage.locator('.topbar [data-action="assistant"]').click();
  await rejectPage.locator('[data-task="icon"]').click();
  assert.equal(await rejectPage.locator('#detail-date').inputValue(),'');
  await rejectPage.close();
  check('Dismissing a suggestion leaves the demo task unchanged.');

  await nav('today');
  await page.locator('.topbar [data-action="assistant"]').click();
  await screenshot('today-desktop-assistant');
  await page.locator('.topbar [data-action="theme"]').click();
  await screenshot('today-desktop-dark');
  await page.locator('.topbar [data-action="language"]').click();
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('#main h1').innerText(),'Today');
  await screenshot('today-desktop-dark-en');
  check('Dark theme and English apply to the page, navigation and assistant.');

  for (const mode of ['empty','loading','error','normal']) {
    await page.locator('[data-control="mode"]').selectOption(mode);
    await noOverflow();
    if(mode==='error')await page.getByRole('button',{name:'Retry',exact:true}).click();
  }
  check('Empty, loading and error previews render; retry returns to normal.');

  for (const width of [390,740,1024,1440]) {
    await page.setViewportSize({width,height:900});
    await noOverflow();
  }
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.querySelector('aside.assistant')?.getAttribute('aria-modal')==='true');
  assert.equal(await page.locator('.assistant').getAttribute('aria-modal'),'true');
  await page.locator('.assistant [data-action="assistant"]').click();
  await page.locator('.topbar [data-action="language"]').click();
  await page.locator('.topbar [data-action="theme"]').click();
  await screenshot('today-mobile-light');
  await page.locator('.mobile-nav [data-nav="library"]').click();
  await noOverflow();
  await screenshot('library-mobile-light');
  await page.locator('.mobile-nav [data-nav="plan"]').click();
  await noOverflow();
  await page.locator('[data-plan-mode="day"]').click();
  await screenshot('plan-mobile-light');
  await page.locator('.mobile-nav [data-nav="more"]').click();
  await page.locator('#main [data-nav="knowledge"]').click();
  await noOverflow();
  await page.locator('.topbar [data-action="assistant"]').click();
  await page.locator('[data-form="chat"] textarea').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.assistant')),true);
  await screenshot('assistant-mobile-light');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.assistant').count(),0);
  await page.locator('.mobile-menu-button').click();
  await page.locator('details[data-advanced] summary').click();
  await page.locator('.sidebar [data-nav="worktrees"]').click();
  await page.locator('.mobile-menu-button').click();
  assert.notEqual(await page.locator('details[data-advanced]').getAttribute('open'),null);
  await page.keyboard.press('Escape');
  check('390px navigation, full-screen assistant, focus containment, Escape and active advanced group work.');

  // Additional language/theme/page combinations catch untranslated layout and hidden overflow.
  for(const lang of ['zh','en']) {
    if(await page.locator('html').getAttribute('lang')!==(lang==='zh'?'zh-CN':'en'))await page.locator('.topbar [data-action="language"]').click();
    for(const theme of ['light','dark']) {
      if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('.topbar [data-action="theme"]').click();
      for(const view of ['today','plan','library','knowledge','brand']) {
        await page.evaluate(view=>{location.hash=view;},view);
        await page.waitForFunction(view=>location.hash===`#${view}`&&document.querySelector('.mobile-nav [aria-current=page]')?.dataset.nav===(['today','plan','library'].includes(view)?view:'more'),view);
        await noOverflow();
      }
    }
  }
  check('Representative pages fit in both languages and themes at mobile width.');

  const svg=await readFile(join(root,'../assets/dovun-mark.svg'),'utf8');
  assert.equal((svg.match(/<path /g)||[]).length,3);
  assert.equal(/gradient|filter|image|stroke=/.test(svg),false);
  const iconChecks=[];
  for(const size of [16,24,32]) {
    const {data,info}=await sharp(Buffer.from(svg)).resize(size,size).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const seen=new Set();const components=[];
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const at=y*size+x;if(seen.has(at)||data[at*info.channels+3]<128)continue;
      const queue=[at];seen.add(at);let count=0;
      while(queue.length){const p=queue.pop();count++;const px=p%size,py=Math.floor(p/size);for(const [nx,ny]of[[px-1,py],[px+1,py],[px,py-1],[px,py+1]]){if(nx<0||nx>=size||ny<0||ny>=size)continue;const q=ny*size+nx;if(!seen.has(q)&&data[q*info.channels+3]>=128){seen.add(q);queue.push(q);}}}
      components.push(count);
    }
    assert.equal(components.length,3,`${size}px should retain three separate shapes`);
    iconChecks.push({size,alphaThreshold:128,components});
  }
  check('Vector has three flat paths; three separate shapes remain at 16, 24 and 32px.');

  // Keep presentation screenshots separate from stress-test data and transient toasts.
  const visual=await context.newPage();
  visual.on('pageerror',e=>errors.push(e.message));
  visual.on('requestfailed',r=>failedRequests.push(r.url()));
  await visual.setViewportSize({width:1440,height:1000});
  await visual.goto(url);
  const shot=name=>visual.screenshot({path:join(evidence,`${name}.png`),fullPage:true,style:'.toast{display:none!important}'});
  const visualNav=async view=>{await visual.locator(`.sidebar [data-nav="${view}"]`).first().click();};
  await shot('today-desktop-light');
  await visual.locator('.topbar [data-action="assistant"]').click();
  await shot('today-desktop-assistant');
  await visual.locator('.topbar [data-action="theme"]').click();
  await shot('today-desktop-dark');
  await visual.locator('.topbar [data-action="language"]').click();
  await shot('today-desktop-dark-en');
  await visual.locator('.topbar [data-action="language"]').click();
  await visual.locator('.topbar [data-action="theme"]').click();
  await visual.locator('.topbar [data-action="assistant"]').click();
  await visualNav('plan');await shot('plan-desktop-light');
  await visualNav('library');await shot('library-desktop-light');
  await visualNav('knowledge');await shot('knowledge-desktop-light');
  await visualNav('today');
  await visual.locator('[data-task="brand"]').click();
  await shot('task-detail-desktop-light');
  await visual.keyboard.press('Escape');
  await visual.setViewportSize({width:390,height:844});
  await shot('today-mobile-light');
  await visual.locator('.mobile-nav [data-nav="library"]').click();await shot('library-mobile-light');
  await visual.locator('.mobile-nav [data-nav="plan"]').click();
  await visual.locator('[data-plan-mode="day"]').click();await shot('plan-mobile-light');
  await visual.locator('.topbar [data-action="assistant"]').click();await shot('assistant-mobile-light');
  await visual.close();
  assert.deepEqual(errors,[]);assert.deepEqual(failedRequests,[]);
  await writeFile(join(evidence,'qa-report.json'),JSON.stringify({status:'passed',checkedAt:new Date().toISOString(),scope:'Standalone sample, not production acceptance',checks,iconChecks,errors,failedRequests},null,2)+'\n');
  console.log(JSON.stringify({status:'passed',checks:checks.length,iconChecks,errors,failedRequests}));
} finally { await browser.close(); }
