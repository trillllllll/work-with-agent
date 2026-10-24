// Source boundary check: business pages compose public controls; only ui/ owns native primitives.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = fileURLToPath(new URL('../client/src/', import.meta.url));
const native = new Set(['button', 'input', 'textarea', 'select', 'details', 'summary']);
const publicControls = new Set(['Button', 'Input', 'Textarea', 'Checkbox', 'Radio', 'Switch', 'NativeSelect', 'Disclosure', 'DisclosureTrigger', 'Surface', 'Modal', 'ActionMenu', 'ActionMenuItem', 'TableRow', 'TagChip']);
const failures = [], coverage = {};
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (path !== join(root, 'components/ui')) scan(path); continue; }
    if (!path.endsWith('.tsx')) continue;
    const source = readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = new Set();
    for (const stmt of ast.statements) if (ts.isImportDeclaration(stmt) && /(?:@\/components\/ui\/|components\/ui\/)/.test(stmt.moduleSpecifier.text)) {
      const bindings = stmt.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const spec of bindings.elements) imports.add(spec.name.text);
    }
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(ast), line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
        const at = `${relative(root, path)}:${line}`;
        const className = node.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.text === 'className');
        if (className?.initializer?.getText(ast).includes('task-tag-chip') && tag !== 'TagChip') failures.push(`${at}: use the public TagChip`);
        if (native.has(tag)) failures.push(`${at}: native <${tag}> belongs in components/ui`);
        if (publicControls.has(tag)) {
          if (!imports.has(tag)) failures.push(`${at}: ${tag} must be imported from components/ui`);
          coverage[tag] = (coverage[tag] ?? 0) + 1;
        }
        for (const attr of node.attributes.properties) if (ts.isJsxAttribute(attr) && attr.name.text === 'role' && attr.initializer && ts.isStringLiteral(attr.initializer)) {
          if (attr.initializer.text === 'switch' && tag !== 'Switch') failures.push(`${at}: use the public Switch`);
          if (attr.initializer.text === 'checkbox' && tag !== 'Checkbox') failures.push(`${at}: use the public Checkbox`);
          if (['dialog', 'menu', 'menuitem', 'combobox'].includes(attr.initializer.text)) failures.push(`${at}: compose public dialog/menu/select controls instead of recreating ARIA behavior`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
scan(root);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Shared control boundary passed: ${JSON.stringify(coverage)}`);
