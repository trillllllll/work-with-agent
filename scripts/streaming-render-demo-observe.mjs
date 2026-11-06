// Observe fixed-fixture render timing; Vite must be running on 127.0.0.1:5186.
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const evidence = new URL('../test-results/streaming-render-observations/', import.meta.url);
await mkdir(evidence, { recursive: true });
const browser=await chromium.launch({headless:true});
const observations=[];
for(const speed of ['0.5','4']){
 for(const name of ['Markdown','Chart','Mermaid','SVG','HTML']){
  const page=await browser.newPage({viewport:{width:1440,height:1080},locale:'zh-CN'});
  const errors=[],failed=[],external=[],api=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  page.on('requestfailed',r=>failed.push(r.url()));
  page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith('http://127.0.0.1:5186/'))external.push(r.url());if(r.url().includes('/api/'))api.push(r.url())});
  await page.goto('http://127.0.0.1:5186/streaming-render-demo.html');
  await page.getByRole('button',{name:new RegExp('^'+name+' ')}).click();
  await page.getByLabel('播放速度').selectOption(speed);
  if(speed==='4')await page.getByLabel('分块大小').selectOption('128');
  await page.getByRole('button',{name:'开始演示',exact:true}).click();
  await page.getByTestId('stream-status').filter({hasText:'生成完成'}).waitFor({timeout:20000});
  const metrics=await page.locator('.stream-metrics').innerText();
  const beforeEnd=await page.getByTestId('render-count').getAttribute('data-first-before-end');
  observations.push({name,speed,chunkBytes:speed==='4'?128:32,metrics,beforeEnd,errors,failed,external,api});
  if(speed==='0.5')await page.screenshot({path:new URL(`${name.toLowerCase()}-complete.png`, evidence).pathname,fullPage:true});
  if(speed==='0.5'&&name==='HTML'){
   await page.getByRole('button',{name:'切换深色'}).click();
   await page.screenshot({path:new URL('desktop-dark-html.png', evidence).pathname,fullPage:true});
  }
  await page.close();
 }
}
await writeFile(new URL('observations.json', evidence),JSON.stringify(observations,null,2));
console.log(JSON.stringify(observations));
await browser.close();
