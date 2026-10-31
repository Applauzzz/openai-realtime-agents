import assert from 'node:assert/strict';
import test from 'node:test';
import type { RealtimeItem } from '@openai/agents/realtime';

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
