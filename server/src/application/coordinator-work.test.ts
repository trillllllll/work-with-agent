import {it,expect} from 'vitest';
import {coordinatorWork,pauseCoordinatorWork} from './coordinator-work.js';
it('waits for in-flight work and blocks new background work until an aborted binding resumes it',async()=>{
 let release!:()=>void,ran=false,paused=false;
 const active=coordinatorWork(()=>new Promise<void>(r=>{release=r;}));
 await Promise.resolve();
 const stopping=pauseCoordinatorWork().then(resume=>{paused=true;return resume;});
 await Promise.resolve();expect(paused).toBe(false);
 await coordinatorWork(async()=>{ran=true;});expect(ran).toBe(false);
 release();await active;const resume=await stopping;expect(paused).toBe(true);
 resume();await coordinatorWork(async()=>{ran=true;});expect(ran).toBe(true);
});
