/** Quiesce background writes before changing this process into a cloud replica. */
let paused=false;
const inFlight=new Set<Promise<unknown>>();
export function coordinatorWork<T>(work:()=>Promise<T>): Promise<T|undefined> {
 if(paused)return Promise.resolve(undefined);
 const pending=Promise.resolve().then(work);inFlight.add(pending);
 void pending.finally(()=>inFlight.delete(pending)).catch(()=>{});
 return pending;
}
export async function pauseCoordinatorWork() {
 paused=true;await Promise.allSettled([...inFlight]);
 return ()=>{paused=false;};
}
