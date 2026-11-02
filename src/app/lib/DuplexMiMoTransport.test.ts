import assert from 'node:assert/strict';
import test from 'node:test';
import type { RealtimeItem } from '@openai/agents/realtime';
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime';
import { z } from 'zod';

const modulePath = './DuplexMiMoTransport.ts';
const { DuplexMiMoTransport } = await import(modulePath);

test('maps accepted audio and retained interruption into SDK history', () => {
  const transport = new DuplexMiMoTransport({
    url: 'ws://unused',
  });
  const items: Array<Record<string, any>> = [];
  let interrupted = false;
  transport.on('item_update', (item: RealtimeItem) => items.push(item));
  transport.on('audio_interrupted', () => {
    interrupted = true;
  });

  const serverEvent = (transport as any).handleServerEvent.bind(transport);
  serverEvent({ type: 'chat.started', turn_id: 7 });
  serverEvent({ type: 'chat.delta', turn_id: 7, delta: '未完成回答' });
  serverEvent({
    type: 'chat.cancelled',
    turn_id: 7,
    retained: true,
    interruption_marker: '⏸',
  });

  assert.deepEqual(items[0], {
    itemId: 'user-7',
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [{
      type: 'input_audio',
      audio: null,
      transcript: null,
    }],
  });
  assert.equal(items.at(-1)?.status, 'incomplete');
  assert.equal(items.at(-1)?.content[0].transcript, '未完成回答⏸');
  assert.equal(interrupted, true);
});

test('real SDK dynamically registers and completes session-local Mac echo', { timeout: 3000 }, async () => {
  const transport = new DuplexMiMoTransport({ url: 'ws://unused' });
  const sent: any[] = [];
  const serverEvent = (transport as any).handleServerEvent.bind(transport);
  (transport as any).sendJson = (event: any) => {
    sent.push(event);
    if (event.type === 'agent.mac.invoke') {
      queueMicrotask(() => serverEvent({
        type: 'agent.mac.result', call_id: event.call_id,
        output: '{"status":"succeeded","data":{"text":"hello"}}',
      }));
    }
  };
  transport.connect = async () => {};
  const agent = new RealtimeAgent<{ macTransport: typeof transport }>({
    name: 'echo-agent', instructions: 'Use Mac echo when requested.', tools: [],
  });
  const session = new RealtimeSession(agent, {
    transport, context: { macTransport: transport }, tracingDisabled: true,
  });
  const errors: unknown[] = [];
  session.on('error', (error) => errors.push(error));
  await session.connect({ apiKey: 'local-test' });
  agent.tools.push(tool({
    name: 'demo_echo', description: 'echo',
    parameters: z.object({ text: z.string().max(200) }),
    execute: async (args, context) => (
      (context!.context as { macTransport: typeof transport }).macTransport.executeMacEcho(args)
    ),
  }));
  await session.updateAgent(agent);
  const config = sent.find((event) => event.type === 'agent.session.update');
  assert.equal(config.tools[0].function.parameters.properties.text.maxLength, 200);
  const completed = new Promise<void>((resolve) => session.on('agent_tool_end', () => resolve()));
  serverEvent({ type: 'agent.function_call', call_id: 'echo-sdk',
    name: 'demo_echo', arguments: '{"text":"hello"}' });
  await completed;
  assert.deepEqual(errors, []);
  assert.equal(sent.filter((event) => event.type === 'agent.mac.invoke').length, 1);
  assert.equal(sent.at(-1).type, 'agent.function_call_output');
  const item = session.history.find((item) => item.itemId === 'echo-sdk');
  assert.equal(item?.type, 'function_call');
  assert.equal(item && 'status' in item ? item.status : null, 'completed');
  session.close();
});

test('real SDK executes independent Mac timer tool through v2 dispatch', { timeout: 3000 }, async () => {
  const transport = new DuplexMiMoTransport({ url: 'ws://unused' });
  const sent: any[] = [];
  const serverEvent = (transport as any).handleServerEvent.bind(transport);
  (transport as any).sendJson = (event: any) => {
    sent.push(event);
    if (event.type === 'agent.mac.m2.invoke') queueMicrotask(() => serverEvent({
      type: 'agent.mac.result', call_id: event.call_id,
      output: '{"status":"succeeded","data":{"timers":[]}}',
    }));
  };
  transport.connect = async () => {};
  const agent = new RealtimeAgent({
    name: 'timer-agent', instructions: 'Use timer_list for local timers.',
    tools: [tool({
      name: 'timer_list', description: 'List local Mac timers', parameters: z.object({}),
      execute: async () => transport.executeMacTool('timer_list', {}),
    })],
  });
  const session = new RealtimeSession(agent, { transport, tracingDisabled: true });
  await session.connect({ apiKey: 'local-test' });
  const ended = new Promise<void>((resolve) => session.on('agent_tool_end', () => resolve()));
  serverEvent({ type: 'agent.function_call', call_id: 'timer-sdk',
    name: 'timer_list', arguments: '{}' });
  await ended;
  assert.equal(sent.find((e) => e.type === 'agent.mac.m2.invoke').name, 'timer_list');
  assert.equal(sent.at(-1).type, 'agent.function_call_output');
  const item = session.history.find((i) => i.itemId === 'timer-sdk');
  assert.equal(item && 'status' in item ? item.status : null, 'completed');
  session.close();
});

test('interruption suppresses pending Mac and existing tool outputs', async () => {
  const transport = new DuplexMiMoTransport({ url: 'ws://unused' });
  const sent: any[] = [];
  (transport as any).sendJson = (event: any) => sent.push(event);
  const serverEvent = (transport as any).handleServerEvent.bind(transport);
  serverEvent({ type: 'agent.function_call', call_id: 'old-call',
    name: 'demo_echo', arguments: '{"text":"hello"}' });
  const pending = transport.executeMacEcho({ text: 'hello' });
  const rejected = assert.rejects(pending, /interrupted/);
  transport.interrupt();
  await rejected;
  serverEvent({ type: 'agent.mac.result', call_id: 'old-call', output: 'late' });
  transport.sendFunctionCallOutput({
    id: 'old-call', callId: 'old-call', type: 'function_call',
    name: 'demo_echo', arguments: '{"text":"hello"}',
  }, 'late');
  assert.equal(sent.filter((event) => event.type === 'agent.function_call_output').length, 0);
});

test('updates the same tool item from running to completed output', () => {
  const transport = new DuplexMiMoTransport({
    url: 'ws://unused',
  });
  const items: Array<Record<string, any>> = [];
  transport.on('item_update', (item: RealtimeItem) => items.push(item));
  const serverEvent = (transport as any).handleServerEvent.bind(transport);
  (transport as any).sendJson = () => {};

  serverEvent({
    type: 'agent.function_call',
    call_id: 'call-search-1',
    name: 'search_web',
    arguments: '{"query":"AI news","num":3}',
  });
  transport.sendFunctionCallOutput({
    id: 'call-search-1',
    type: 'function_call',
    name: 'search_web',
    callId: 'call-search-1',
    arguments: '{"query":"AI news","num":3}',
  }, '{"results":[{"title":"Result"}]}');

  assert.equal(items.length, 2);
  assert.equal(items[0].itemId, 'call-search-1');
  assert.equal(items[0].status, 'in_progress');
  assert.equal(items[0].output, null);
  assert.equal(items[1].itemId, 'call-search-1');
  assert.equal(items[1].status, 'completed');
  assert.equal(items[1].output, '{"results":[{"title":"Result"}]}');
});
