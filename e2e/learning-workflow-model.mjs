// Deterministic model transport fixture, not a substitute for real-model teaching evaluation.
import http from 'node:http';

const port = Number(process.env.LEARNING_E2E_MODEL_PORT ?? 4038);
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
const completion = (response, text, stream) => {
  if (!stream) return json(response, 200, { choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 60 }, model: 'learning-workflow-fixture' })}\n\n`);
  response.end('data: [DONE]\n\n');
};

const generation = input => {
  const { config, nodes } = input;
  if (!config || !Array.isArray(nodes) || !nodes.length || !Number.isInteger(config.count)) throw new Error('Invalid generation input fixture contract');
  const types = config.types?.length ? config.types : ['single'];
  return {
    title: '学习练习验收题集',
    questions: Array.from({ length: config.count }, (_, index) => {
      const node = nodes[index % nodes.length], type = types[index % types.length];
      const options = type === 'short' ? [] : type === 'boolean'
        ? [{ id: 'true', text: '正确' }, { id: 'false', text: '错误' }]
        : [{ id: 'a', text: '提交时保存原始答案' }, { id: 'b', text: '重做时覆盖历史答案' }, { id: 'c', text: type === 'multiple' ? '保留每次作答记录' : '只保存最后一次得分' }];
      return {
        nodeId: node.id, type,
        prompt: `练习验收第 ${index + 1} 题：${type === 'short' ? '请说明为什么应保留每次作答记录。' : type === 'boolean' ? '题目修改后，原作答仍应关联当时题目版本。' : type === 'multiple' ? '哪些行为可以保留可核查的学习记录？' : '提交答案时，哪种行为能够保留可核查的学习记录？'}`,
        options, answer: type === 'short' ? '保留原始答案和题目版本，才能回看每次学习过程。' : type === 'boolean' ? 'true' : type === 'multiple' ? ['a', 'c'] : 'a',
        explanation: '验收解析：原始答案和对应题目版本应保留，后续重做产生新的作答记录。',
        rubric: '提到保留原始答案、题目版本或历史可核查性即可；简答满分 1。',
        hints: ['想想重做后是否还需要回看旧答案。'], difficulty: config.difficulty,
        objective: '理解学习记录持久化', source: { kind: 'note', label: node.title, nodeRevision: node.revision },
      };
    }),
  };
};

const server = http.createServer(async (request, response) => {
  if (request.url === '/health') return json(response, 200, { fixture: 'learning-workflow', ok: true });
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(response, 404, { error: 'not found' });
  try {
    let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 1_000_000) throw new Error('Fixture input too large'); }
    const body = JSON.parse(raw || '{}');
    const system = body.messages?.filter(message => message.role === 'system').map(message => message.content ?? '').join('\n') ?? '';
    const user = [...(body.messages ?? [])].reverse().find(message => message.role === 'user')?.content ?? '';
    if (system.includes('DOVUN_PRACTICE_GENERATE_V1')) return completion(response, JSON.stringify(generation(JSON.parse(user))), body.stream);
    if (system.includes('DOVUN_PRACTICE_GRADE_V1')) {
      const input = JSON.parse(user), answer = String(input.answer ?? '');
      if (answer.includes('fixture-model-failure')) return json(response, 503, { error: 'Controlled grading fixture failure' });
      const disputed = answer.includes('有争议'), correct = /原始答案|题目版本|可核查|历史/.test(answer);
      return completion(response, JSON.stringify({ result: disputed ? 'unresolved' : correct ? 'correct' : 'incorrect', score: disputed ? null : correct ? 1 : 0, maxScore: 1, explanation: disputed ? '验收样例需人工复核。' : '按题目保存的评分依据检查是否说明记录可核查性。', strengths: correct ? '指出了历史证据的作用。' : '', mistakes: correct ? [] : ['未说明为什么保留原始记录'], needsReview: disputed }), body.stream);
    }
    return completion(response, '可以先回看当前题目的考点，再比较你的思路；这是一条学习辅导验收回复。', body.stream);
  } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : 'Invalid fixture request' }); }
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
