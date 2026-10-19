// Verifies i18n: every client namespace has the same keys in each locale, no
// Chinese text is left in client/src outside the locale files, and every
// user-visible server message (scripts/server-messages.mjs) has an English entry
// in server/src/i18n/locales/en.ts with the same placeholders.
// Escape hatches: a line comment containing `i18n-ignore` on the same or previous
// line, or `i18n-ignore-file` anywhere in a file (for model prompts / protocol text).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { collectServerMessages } from './server-messages.mjs';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'client/src');
const localesDir = join(src, 'i18n/locales');
const cjk = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
const errors = [];
const args = process.argv.slice(2);
const only = args.filter((arg) => !arg.startsWith('--')).map((arg) => resolve(arg));

// 1. Locale key parity. English values must not contain Chinese, except native
// language names under `language.options.*`.
const plural = /_(zero|one|two|few|many|other)$/;
const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => child && typeof child === 'object' ? flatten(child, `${prefix}${key}.`) : [`${prefix}${key}`.replace(plural, '')]);
const languages = readdirSync(localesDir).filter((name) => statSync(join(localesDir, name)).isDirectory());
const namespaces = new Set(languages.flatMap((language) => readdirSync(join(localesDir, language)).filter((file) => file.endsWith('.json'))));
for (const file of namespaces) {
  const keySets = languages.map((language) => {
    try { return new Set(flatten(JSON.parse(readFileSync(join(localesDir, language, file), 'utf8')))); }
    catch (error) { errors.push(`${language}/${file}: ${error.message}`); return new Set(); }
  });
  languages.forEach((language, index) => {
    for (const other of keySets.filter((_, at) => at !== index)) for (const key of other) if (!keySets[index].has(key)) errors.push(`${language}/${file}: missing key "${key}"`);
  });
  const enPath = join(localesDir, 'en', file);
  try {
    const en = JSON.parse(readFileSync(enPath, 'utf8'));
    const walk = (value, path) => { for (const [key, child] of Object.entries(value)) { if (child && typeof child === 'object') walk(child, `${path}${key}.`); else if (typeof child === 'string' && cjk.test(child) && !`${path}${key}`.startsWith('language.options.')) errors.push(`en/${file}: "${path}${key}" still contains Chinese`); } };
    walk(en, '');
  } catch { /* reported above */ }
}

// 2. No Chinese literals in client sources.
const files = [];
const collect = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) { if (path !== localesDir) collect(path); } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) files.push(path); } };
collect(src);
let literalCount = 0;
for (const path of files) {
  if (only.length && !only.some((prefix) => path.startsWith(prefix))) continue;
  const text = readFileSync(path, 'utf8');
  if (text.includes('i18n-ignore-file')) continue;
  const lines = text.split('\n');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node) || ts.isRegularExpressionLiteral(node)) {
      const value = node.getText(source);
      if (cjk.test(value)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        if (!(lines[line]?.includes('i18n-ignore') || lines[line - 1]?.includes('i18n-ignore'))) {
          literalCount += 1;
          errors.push(`${relative(root, path)}:${line + 1}: Chinese literal ${value.trim().slice(0, 60)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

// 3. Server locale parity: zh-CN is the source text; en must cover exactly the collected messages.
const serverLocalePath = join(root, 'server/src/i18n/locales/en.ts');
let serverMessageCount = 0;
try {
  const text = readFileSync(serverLocalePath, 'utf8');
  const start = text.indexOf('{', text.indexOf('='));
  const end = text.lastIndexOf('}');
  const serverEn = JSON.parse(text.slice(start, end + 1));
  const collected = collectServerMessages();
  const keys = new Set(collected.map((message) => message.key));
  serverMessageCount = keys.size;
  const placeholders = (value) => [...value.matchAll(/\{(\d+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const message of collected) {
    if (!(message.key in serverEn)) errors.push(`${message.file}:${message.line}: server message has no English entry: ${message.key.slice(0, 80)}`);
  }
  for (const [key, value] of Object.entries(serverEn)) {
    if (!keys.has(key)) errors.push(`server en: stale entry no longer used in server/src: ${key.slice(0, 80)}`);
    if (typeof value !== 'string' || !value.trim()) errors.push(`server en: empty translation for ${key.slice(0, 80)}`);
    else {
      if (cjk.test(value)) errors.push(`server en: "${key.slice(0, 60)}" still contains Chinese`);
      if (placeholders(key) !== placeholders(value)) errors.push(`server en: placeholders differ for ${key.slice(0, 80)}`);
    }
  }
} catch (error) { errors.push(`server/src/i18n/locales/en.ts: ${error.message}`); }

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(`\ni18n check failed: ${errors.length} problem(s), ${literalCount} untranslated literal(s).`);
  process.exit(1);
}
console.log(`i18n check passed: ${namespaces.size} namespace(s) in ${languages.join(', ')}, ${files.length} source files clean, ${serverMessageCount} server message(s) translated.`);
