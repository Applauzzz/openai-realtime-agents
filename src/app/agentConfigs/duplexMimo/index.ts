import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';

import manifest from './manifest.json';

export type DuplexMimoToolManifest = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type DuplexMimoAgentManifest = {
  name: string;
  instructions: string;
  handoffs: string[];
  tools: DuplexMimoToolManifest[];
};

export type DuplexMimoManifest = {
  root_agent: string;
  max_tool_rounds: number;
  agents: DuplexMimoAgentManifest[];
};

export const duplexMimoManifest = manifest as DuplexMimoManifest;

const searchWeb = tool({
  name: 'search_web',
  description: (
    '搜索互联网中的最新公开信息。用户询问新闻、当前事件、最新状态、'
    + '近期发布内容或其他可能变化的信息时使用。'
  ),
  parameters: z.object({
    query: z.string().min(1).max(500).describe('清晰、具体的搜索查询。'),
    num: z.number().int().min(1).max(10).default(5)
      .describe('返回结果数量，1 到 10，默认 5。'),
  }),
  execute: async ({ query, num = 5 }) => {
    const response = await fetch('/api/tools/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, num }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Web search failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    return response.json();
  },
});

const getCurrentDatetime = tool({
  name: 'get_current_datetime',
  description: '按需获取北京时间的当前日期、时间和星期。仅在用户明确询问日期或时间时调用。',
  parameters: z.object({}),
  execute: async () => {
    const now = new Date();
    const timeZone = 'Asia/Shanghai';
    return {
      iso: now.toISOString(),
      beijingTime: new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now),
      timeZone,
    };
  },
});

const agents = new Map<string, RealtimeAgent>();

for (const spec of duplexMimoManifest.agents) {
  agents.set(spec.name, new RealtimeAgent({
    name: spec.name,
    instructions: spec.instructions,
    tools: spec.name === duplexMimoManifest.root_agent
      ? [searchWeb, getCurrentDatetime]
      : [],
    handoffs: [],
  }));
}

for (const spec of duplexMimoManifest.agents) {
  const agent = agents.get(spec.name)!;
  (agent.handoffs as RealtimeAgent[]).push(
    ...spec.handoffs.map((name) => {
      const destination = agents.get(name);
      if (!destination) {
        throw new Error(`Unknown duplex MiMo handoff destination: ${name}`);
      }
      return destination;
    }),
  );
}

export const duplexMimoScenario = duplexMimoManifest.agents.map((spec) =>
  agents.get(spec.name)!,
);
