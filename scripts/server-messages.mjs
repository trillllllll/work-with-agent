// Collects the user-visible Chinese messages in server/src: the message argument of
// error constructors/helpers and string values of `error` / `message` properties.
// Template literals become keys with positional placeholders: `a${x}b` -> "a{0}b".
// The server translates these source strings per request (server/src/i18n).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const root = resolve(import.meta.dirname, '..');
const serverSrc = join(root, 'server/src');
export const cjk = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

// callee name -> index of its message argument
const messageCallees = new Map(Object.entries({
  DomainError: 1, Error: 0, knowledgeFailure: 1, learningFailure: 1, libraryError: 1, skillFailure: 1, failure: 1, fail: 1,
  badRequest: 0, notFound: 0, conflict: 0, modelError: 0, pathError: 0, invalid: 0, unavailable: 0, pauseOwned: 3,
  assertExpected: 2, requireResource: 1, failJob: 2, localize: 0,
  // zod validation messages, which reach the client in VALIDATION_ERROR / INVALID_* responses
  refine: 1, min: 1, max: 1, length: 1, regex: 1, email: 0, url: 0,
}));
// receiver.method calls whose argument is a user-visible message
const messageMethods = new Map(Object.entries({ 'warnings.push': 0 }));
const messageProperties = new Set(['error', 'message', 'errorMessage', 'summaryError']);

export function templateKey(node, source) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span, index) => `{${index}}${span.literal.text}`).join('');
  return null;
}

function literalsIn(node, source, found) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    const key = templateKey(node, source);
    if (key && cjk.test(key)) found.push({ key, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    return;
  }
  // Only descend through expressions that pick a value, not into nested calls.
  if (ts.isConditionalExpression(node)) { literalsIn(node.whenTrue, source, found); literalsIn(node.whenFalse, source, found); }
  else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) { literalsIn(node.left, source, found); literalsIn(node.right, source, found); }
  else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) literalsIn(node.expression, source, found);
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

export function serverSourceFiles() {
  const files = [];
  const collect = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) collect(path); else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts')) files.push(path); } };
  collect(serverSrc);
  return files;
}

export function collectServerMessages() {
  const messages = [];
  for (const path of serverSourceFiles()) {
    const text = readFileSync(path, 'utf8');
    if (!cjk.test(text)) continue;
    const lines = text.split('\n');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      const found = [];
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
        const index = messageCallees.get(calleeName(node.expression)) ?? messageMethods.get(node.expression.getText(source));
        if (index !== undefined && node.arguments[index]) literalsIn(node.arguments[index], source, found);
      } else if (ts.isPropertyAssignment(node) && messageProperties.has(node.name.getText(source).replace(/['"]/g, ''))) {
        literalsIn(node.initializer, source, found);
      }
      for (const item of found) {
        if (lines[item.line - 1]?.includes('i18n-ignore') || lines[item.line - 2]?.includes('i18n-ignore')) continue;
        messages.push({ ...item, file: relative(root, path) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return messages;
}

if (process.argv[1] === import.meta.filename) {
  const messages = collectServerMessages();
  const unique = [...new Set(messages.map((message) => message.key))];
  if (process.argv.includes('--json')) console.log(JSON.stringify(unique, null, 2));
  else { for (const message of messages) console.log(`${message.file}:${message.line}: ${message.key}`); console.log(`${messages.length} sites, ${unique.length} unique`); }
}
