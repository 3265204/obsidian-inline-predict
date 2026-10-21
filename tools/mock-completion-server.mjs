#!/usr/bin/env node
/**
 * Local OpenAI-compatible mock completion server for manual testing.
 *
 * Purpose: let the Obsidian plugin perform a real HTTP round-trip and render ghost text without a
 * paid provider or an API key. It is a test harness, not a model: responses are canned based on
 * simple keyword matching on the prompt.
 *
 *   node tools/mock-completion-server.mjs            # listens on 127.0.0.1:8765
 *   PORT=9000 node tools/mock-completion-server.mjs
 *
 * 在 Obsidian 中打开：设置 → Inline Predict
 *   Base URL  http://127.0.0.1:8765/v1
 *   API key   local-mock
 *   Model ID  mock-model
 *
 * Every request is appended to .tmp/mock-requests.log so the round-trip can be verified.
 */

import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number(process.env.PORT ?? 8765);
const HOST = '127.0.0.1';
const LOG = resolve(process.env.MOCK_LOG ?? resolve(ROOT, '.tmp', 'mock-requests.log'));
mkdirSync(dirname(LOG), { recursive: true });

/** Canned continuations; first matching rule wins. */
const RULES = [
	{ test: /特征值描述了线性变换在/, reply: '特征向量方向上的缩放比例。' },
	{ test: /设矩阵 A 的特征值为 λ/, reply: 'A v = λ v。' },
	{ test: /第二项：/, reply: '矩阵对角化与相似变换' },
	{ test: /- 第一项/, reply: '\n- 第二项：相似矩阵具有相同的特征多项式' },
	{ test: /中文也可以/, reply: '，而且中英文混排也不会打断预测。' },
	{ test: /The plugin predicts/, reply: ' the next words as you type.' },
	{ test: /## 1\. 中文句子补全/, reply: '特征向量方向上的缩放比例。' },
];

function pickContinuation(prompt) {
	for (const rule of RULES) {
		if (rule.test.test(prompt)) return rule.reply;
	}
	return '（本地 mock 补全）继续输入的内容。';
}

function readBody(request) {
	return new Promise((resolveBody, rejectBody) => {
		const chunks = [];
		request.on('data', (chunk) => chunks.push(chunk));
		request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
		request.on('error', rejectBody);
	});
}

function promptFromRequestBody(raw) {
	try {
		const parsed = JSON.parse(raw);
		const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const user = [...messages].reverse().find((message) => message?.role === 'user');
		return typeof user?.content === 'string' ? user.content : '';
	} catch {
		return '';
	}
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);

	if (request.method === 'GET' && url.pathname === '/health') {
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ ok: true, port: PORT }));
		return;
	}

	// Accept both /v1/chat/completions and /chat/completions so a slightly different base URL works.
	if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
		const raw = await readBody(request);
		const prompt = promptFromRequestBody(raw);
		const reply = pickContinuation(prompt);
		const entry = {
			at: new Date().toISOString(),
			bytes: Buffer.byteLength(raw),
			promptPreview: prompt.slice(-160),
			reply,
		};
		appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
		const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(raw) / 4));
		const outputTokens = Math.max(1, Math.ceil(Buffer.byteLength(reply) / 4));
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(
			JSON.stringify({
				id: `mock-${Date.now()}`,
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: 'mock-model',
				choices: [
					{
						index: 0,
						message: { role: 'assistant', content: reply },
						finish_reason: 'stop',
					},
				],
				usage: {
					prompt_tokens: inputTokens,
					completion_tokens: outputTokens,
					total_tokens: inputTokens + outputTokens,
				},
			}),
		);
		return;
	}

	response.writeHead(404, { 'Content-Type': 'application/json' });
	response.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, HOST, () => {
	console.log(`mock completion server listening on http://${HOST}:${PORT}/v1`);
	console.log(`requests are logged to ${LOG}`);
});
