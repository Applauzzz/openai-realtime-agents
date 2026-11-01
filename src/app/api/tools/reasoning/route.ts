import OpenAI from 'openai';
import { NextRequest, NextResponse } from 'next/server';

const MODEL = 'gpt-4o';
const BASE_URL = 'http://ichat.woa.com/api/external';
const SYSTEM_PROMPT = (
  'You are a backend reasoning specialist for a realtime multimodal voice assistant. '
  + 'Analyze only the task and context supplied by the caller. Return a concise, '
  + 'actionable answer that the realtime assistant can use to answer the user. '
  + 'Do not claim access to audio, video, tools, current facts, or conversation history '
  + 'that is not explicitly included in the request. Do not address the user directly.'
);

export async function POST(request: NextRequest) {
  const apiKey = process.env.ICHAT_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ICHAT_API_KEY is not configured' },
      { status: 503 },
    );
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }
  const body = payload as Record<string, unknown>;
  const task = body.task;
  const context = body.context ?? '';
  if (typeof task !== 'string' || !task.trim() || task.length > 8_000) {
    return NextResponse.json(
      { error: 'task must be a non-empty string of at most 8000 characters' },
      { status: 400 },
    );
  }
  if (typeof context !== 'string' || context.length > 16_000) {
    return NextResponse.json(
      { error: 'context must be a string of at most 16000 characters' },
      { status: 400 },
    );
  }
  try {
    const client = new OpenAI({ apiKey, baseURL: BASE_URL, timeout: 60_000 });
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: context.trim()
            ? `Task:\n${task.trim()}\n\nContext from MiMo:\n${context.trim()}`
            : `Task:\n${task.trim()}`,
        },
      ],
      temperature: 0.2,
    });
    const answer = response.choices[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) {
      return NextResponse.json(
        { error: 'iChat reasoning model returned no answer' },
        { status: 502 },
      );
    }
    return NextResponse.json({
      model: MODEL,
      answer: answer.trim(),
      usage: response.usage ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'iChat reasoning request failed',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
