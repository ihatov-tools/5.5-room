// Cloudflare Worker (module syntax)
// Secrets: OPENAI_API_KEY, ROOM_SECRET
// Variable (recommended): ALLOWED_ORIGIN = https://YOURNAME.github.io

const MODEL = 'gpt-5.5-2026-04-23';
const PRICE = {
  input: 5.00,       // USD / 1M tokens
  cachedInput: 0.50, // USD / 1M tokens
  output: 30.00      // USD / 1M tokens (reasoning tokens are included)
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').trim();
  const value = allowed || origin || '*';
  return {
    'Access-Control-Allow-Origin': value,
    'Access-Control-Allow-Headers': 'Content-Type, X-Room-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request, env) }
  });
}

function extractText(data) {
  const chunks = [];
  for (const item of (data.output || [])) {
    if (item.type !== 'message') continue;
    for (const part of (item.content || [])) {
      if (part.type === 'output_text' && part.text) chunks.push(part.text);
      if (part.type === 'refusal' && part.refusal) chunks.push(part.refusal);
    }
  }
  return chunks.join('\n');
}

function calculateCost(usage) {
  const input = Number(usage?.input_tokens || 0);
  const cached = Math.min(input, Number(usage?.input_tokens_details?.cached_tokens || 0));
  const uncached = Math.max(0, input - cached);
  const output = Number(usage?.output_tokens || 0);

  // GPT-5.5: prompts above 272K input tokens use 2x input and 1.5x output pricing.
  const longContext = input > 272000;
  const inputRate = PRICE.input * (longContext ? 2 : 1);
  const cachedRate = PRICE.cachedInput * (longContext ? 2 : 1);
  const outputRate = PRICE.output * (longContext ? 1.5 : 1);

  return (uncached * inputRate + cached * cachedRate + output * outputRate) / 1_000_000;
}

async function openai(path, env, init = {}) {
  const r = await fetch('https://api.openai.com/v1' + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + env.OPENAI_API_KEY,
      ...(init.headers || {})
    }
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = data?.error?.message || `OpenAI HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, request, env);

    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').trim();
    if (allowed && origin && origin !== allowed) {
      return json({ error: 'このサイトからは使えません' }, 403, request, env);
    }

    if (!env.OPENAI_API_KEY) return json({ error: 'Worker側にOPENAI_API_KEYがありません' }, 500, request, env);
    if (!env.ROOM_SECRET) return json({ error: 'Worker側にROOM_SECRETがありません' }, 500, request, env);
    if (request.headers.get('x-room-key') !== env.ROOM_SECRET) {
      return json({ error: '部屋の鍵が違います' }, 401, request, env);
    }

    try {
      const body = await request.json();
      const message = String(body.message || '').trim();
      const instructions = String(body.instructions || '').trim();
      let conversationId = body.conversation_id ? String(body.conversation_id) : '';
      if (!message) return json({ error: 'メッセージが空です' }, 400, request, env);

      if (!conversationId) {
        const conv = await openai('/conversations', env, {
          method: 'POST',
          body: JSON.stringify({ metadata: { app: 'chapi-line-55' } })
        });
        conversationId = conv.id;
      }

      const payload = {
        model: MODEL,
        conversation: conversationId,
        input: [{ role: 'user', content: message }],
        reasoning: { effort: 'high' },
        text: { verbosity: 'medium' },
        store: true,
        max_output_tokens: 12000
      };
      if (instructions) payload.instructions = instructions;

      const data = await openai('/responses', env, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      const usage = data.usage || {};
      const cost = calculateCost(usage);
      return json({
        text: extractText(data),
        conversation_id: conversationId,
        response_id: data.id,
        usage,
        cost_usd: cost,
        pricing: PRICE,
        model: MODEL
      }, 200, request, env);
    } catch (e) {
      return json({ error: e?.message || String(e) }, 500, request, env);
    }
  }
};
