import type { HarnessProject } from '@/components/workspace/HarnessProjectPicker.js';
import type { DirectoryPage } from '../../server/src/node-agent/directory-protocol.js';

export const demoComputer = { id: 'demo-mac', name: '演示 Mac', online: true, canBrowse: true };
const root = '/WorkSpace';
const entry = (path: string) => ({ path, name: path.split('/').pop() || path });
export function demoProject(path: string): HarnessProject {
  const { name } = entry(path);
  return { id: path, nodeId: demoComputer.id, projectName: name, computerName: demoComputer.name, path };
}
export const initialProjects = [demoProject(root + '/Dovun'), demoProject(root + '/文档项目')];

export function demoDirectory(path: string | null, projects: HarnessProject[]): DirectoryPage {
  if (!path) return { directory: null, parent: null, entries: [entry(root)], truncated: false };
  const current = path.replace(/\/+$/, '');
  if (current !== root && !current.startsWith(root + '/') || /(?:^|\/)\.\.?($|\/)/.test(current)) {
    throw new Error('演示目录位于 /WorkSpace 下。');
  }
  const paths = [...projects.map((project) => project.path), root + '/产品原型/手机端', root + '/产品原型/桌面端'];
  const children = paths.filter((p) => p.startsWith(current + '/')).map((p) => p.slice(current.length + 1).split('/')[0]);
  return { directory: entry(current), parent: current === root ? null : current.slice(0, current.lastIndexOf('/')),
    entries: [...new Set(children)].sort().map((name) => entry(current + '/' + name)), truncated: false };
}
