'use client';

import {
  Camera,
  CameraOff,
  CheckCircle2,
  CircleStop,
  LoaderCircle,
  Mic,
  MicOff,
  Monitor,
  Phone,
  PhoneOff,
  Radio,
  Link,
  Unlink,
  Volume2,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RealtimeSession,
  type RealtimeItem,
  type RealtimeMessageItem,
  type RealtimeToolCallItem,
} from '@openai/agents/realtime';

import { duplexMimoScenario, macEchoTool, macM2Tools, macToolInstructions } from '../agentConfigs/duplexMimo';
import { RealtimeAgent } from '@openai/agents/realtime';
import { useDuplexMedia } from '../hooks/useDuplexMedia';
import { DuplexMiMoTransport } from '../lib/DuplexMiMoTransport';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

type ActivityItem = {
  id: string;
  kind: 'agent' | 'tool' | 'system';
  title: string;
  detail?: string;
};

type ConversationMessage = Extract<
  RealtimeMessageItem,
  { role: 'user' | 'assistant' }
>;

type ConversationItem = ConversationMessage | RealtimeToolCallItem;

async function browserGrant(action: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`/api/tools/browser/${action}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Browser authorization failed');
  return value;
}

function defaultWebSocketUrl() {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:8081/ws';
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  if (process.env.NEXT_PUBLIC_DUPLEX_MIMO_WS_URL) {
    return process.env.NEXT_PUBLIC_DUPLEX_MIMO_WS_URL;
  }
  if (window.location.port === '3000') {
    return `${scheme}://${window.location.hostname}:8081/ws`;
  }
  return `${scheme}://${window.location.host}/agent-ws`;
}

function messageText(item: RealtimeItem) {
  if (item.type !== 'message') return '';
  return item.content.map((content) => {
    if (content.type === 'input_text' || content.type === 'text') return content.text;
    return content.transcript ?? '';
  }).join('');
}

function formatJson(value: string | null) {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export default function DuplexMiMoPage() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected');
  const [currentAgent, setCurrentAgent] = useState(duplexMimoScenario[0].name);
  const [history, setHistory] = useState<RealtimeItem[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const audioEnabledRef = useRef(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [rememberBrowser, setRememberBrowser] = useState(true);
  const [browserTrusted, setBrowserTrusted] = useState(false);
  const pendingRememberRef = useRef(false);
  const connectingRef = useRef(false);
  const restoreAttemptsRef = useRef(0);
  const [m2Options, setM2Options] = useState<{
    groups: Record<string, string[]>; allowed_scope: string[];
  } | null>(null);
  const [m2Scope, setM2Scope] = useState<string[]>([]);
  const [m2Names, setM2Names] = useState<string[]>([]);
  const [capturePaused, setCapturePaused] = useState(false);
  const capturePausedRef = useRef(false);
  const [confirmation, setConfirmation] = useState<{
    call_id: string; name: string; arguments: Record<string, unknown>;
  } | null>(null);
  const [macStatus, setMacStatus] = useState<{
    enabled: boolean; connected: boolean; device_id?: string | null;
  }>({ enabled: false, connected: false });
  const sessionRef = useRef<RealtimeSession<{
    macTransport: DuplexMiMoTransport; history: RealtimeItem[];
  }> | null>(null);
  const transportRef = useRef<DuplexMiMoTransport | null>(null);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const followConversationRef = useRef(true);
  const {
    mediaState,
    cameraEnabled,
    inputLevel,
    videoRef,
    start,
    stop,
    setCamera,
    playPcm,
    stopPlayback,
    pauseCapture,
  } = useDuplexMedia();
  const pauseCaptureRef = useRef(pauseCapture);
  pauseCaptureRef.current = pauseCapture;

  const appendActivity = useCallback((item: ActivityItem) => {
    setActivity((current) => [...current.slice(-39), item]);
  }, []);

  const connect = useCallback(async () => {
    if (connectingRef.current || sessionRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setConnectionState('error');
      setErrorMessage(
        'Microphone access is unavailable. Open this page from a secure origin or allow this server origin in the browser.',
      );
      return;
    }
    setConnectionState('connecting');
    connectingRef.current = true;
    setErrorMessage('');
    const transport = new DuplexMiMoTransport({
      url: defaultWebSocketUrl(),
      configure: {
        tts_enabled: true,
        audio_chunk_ms: 500,
        retain_interrupted_context: true,
      },
    });
    const baselineAgent = duplexMimoScenario[0];
    if (typeof baselineAgent.instructions !== 'string') {
      throw new Error('Duplex MiMo requires manifest instructions');
    }
    const agent = new RealtimeAgent<{
      macTransport: DuplexMiMoTransport; history: RealtimeItem[];
    }>({
      name: baselineAgent.name,
      instructions: baselineAgent.instructions + macToolInstructions,
      tools: [...baselineAgent.tools],
      handoffs: baselineAgent.handoffs.filter(
        (handoff): handoff is RealtimeAgent => handoff instanceof RealtimeAgent,
      ),
    });
    const session = new RealtimeSession(agent, {
      transport,
      context: { macTransport: transport, history: [] },
      model: 'mimo-v2.6-flash',
      tracingDisabled: true,
    });
    transportRef.current = transport;
    sessionRef.current = session;
    session.on('history_updated', (items) => setHistory(items));
    session.on('agent_handoff', (_context, from, to) => {
      setCurrentAgent(to.name);
      appendActivity({
        id: crypto.randomUUID(),
        kind: 'agent',
        title: `${from.name} -> ${to.name}`,
        detail: 'Agent handoff completed',
      });
    });
    session.on('agent_tool_start', (_context, agent, tool) => {
      appendActivity({
        id: crypto.randomUUID(),
        kind: 'tool',
        title: tool.name,
        detail: `${agent.name} started tool execution`,
      });
    });
    session.on('agent_tool_end', (_context, agent, tool, result) => {
      appendActivity({
        id: crypto.randomUUID(),
        kind: 'tool',
        title: tool.name,
        detail: result ? String(result) : `${agent.name} completed the tool`,
      });
    });
    session.on('transport_event', (event) => {
      if (event.type === 'agent.mac.m2.options') {
        setM2Options(event as any);
      }
      if (event.type === 'agent.mac.m2.confirmation') {
        setConfirmation(event as any);
      }
      if (event.type === 'agent.capture.pause') {
        capturePausedRef.current = true;
        void pauseCaptureRef.current().then(() => {
          setCapturePaused(true);
          transport.sendRaw({ type: 'agent.capture.paused', request_id: event.request_id, stopped: true });
        }).catch(() => {
          transport.sendRaw({ type: 'agent.capture.paused', request_id: event.request_id, stopped: false });
        });
      }
      if (event.type === 'agent.mac.timer.finished') {
        appendActivity({
          id: String(event.event_id), kind: 'system', title: 'Timer finished',
          detail: JSON.stringify(event.data),
        });
      }
      if (event.type === 'agent.mac.m2.status') {
        const names = Array.isArray(event.available_tools) ? event.available_tools as string[] : [];
        setM2Names(names);
        if (Array.isArray(event.scope)) setM2Scope(event.scope as string[]);
        agent.tools = agent.tools.filter((tool) => !macM2Tools.some((m2) => m2.name === tool.name));
        agent.tools.push(...macM2Tools.filter((tool) => names.includes(tool.name)));
        void session.updateAgent(agent).catch((error) => setErrorMessage(String(error)));
      }
      if (event.type === 'chat.cancelled' || event.type === 'tts.cancelled') {
        setConfirmation(null);
      }
      if (event.type === 'agent.mac.status') {
        if (event.device_id) restoreAttemptsRef.current = 0;
        if (event.device_id && pendingRememberRef.current && typeof event.session_id === 'string') {
          pendingRememberRef.current = false;
          void browserGrant('remember', { session_id: event.session_id, confirmed: true })
            .then(() => setBrowserTrusted(true))
            .catch((error) => setErrorMessage(String(error)));
        }
        setMacStatus({
          enabled: Boolean(event.enabled), connected: Boolean(event.connected),
          device_id: typeof event.device_id === 'string' ? event.device_id : null,
        });
        agent.tools = agent.tools.filter((tool) => tool.name !== 'demo_echo');
        if (event.connected) agent.tools.push(macEchoTool);
        void session.updateAgent(agent).catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        });
      }
      if (event.type === 'agent.mac.error') {
        if (event.message === 'binding_conflict' && restoreAttemptsRef.current++ < 5) {
          window.setTimeout(() => {
            if (transportRef.current === transport) transport.requestMacStatus();
          }, 1000);
        } else {
          setErrorMessage(String(event.message));
        }
      }
      if (event.type === 'chat.started') {
        const frameCount = Number(event.video_frame_count ?? 0);
        appendActivity({
          id: crypto.randomUUID(),
          kind: 'system',
          title: frameCount > 0
            ? `Vision input: ${frameCount} frame${frameCount === 1 ? '' : 's'}`
            : 'Vision input: no frames',
          detail: `Turn ${event.turn_id}`,
        });
      }
      if (event.type === 'chat.error' || event.type === 'error') {
        const message = 'message' in event
          ? event.message
          : ('error' in event ? event.error : 'Unknown backend error');
        appendActivity({
          id: crypto.randomUUID(),
          kind: 'system',
          title: event.type,
          detail: String(message),
        });
      }
    });
    session.on('audio', (event) => {
      if (audioEnabledRef.current && !capturePausedRef.current) void playPcm(event.data);
    });
    session.on('audio_interrupted', () => {
      setConfirmation(null);
      stopPlayback();
      appendActivity({
        id: crypto.randomUUID(),
        kind: 'system',
        title: 'Playback interrupted',
      });
    });
    session.on('error', (error) => {
      const message = String(error.error);
      setErrorMessage(message);
      appendActivity({
        id: crypto.randomUUID(),
        kind: 'system',
        title: 'Session error',
        detail: message,
      });
    });
    try {
      try {
        const grant = await browserGrant('status');
        setBrowserTrusted(Boolean(grant.trusted));
        if (grant.capture_paused) {
          capturePausedRef.current = true;
          setCapturePaused(true);
        }
      } catch {
        // Ordinary connection remains available when browser trust is unavailable.
      }
      await session.connect({ apiKey: 'duplex-mimo-local' });
      transport.requestMacStatus();
      if (!capturePausedRef.current) {
        await start(transport);
      } else {
        await pauseCaptureRef.current();
        transport.sendRaw({ type: 'agent.capture.hold' });
      }
      transport.sendRaw({ type: 'agent.capture.ready', supported: true });
      setConnectionState('connected');
      connectingRef.current = false;
      appendActivity({
        id: crypto.randomUUID(),
        kind: 'system',
        title: 'Duplex MiMo connected',
        detail: defaultWebSocketUrl(),
      });
    } catch (error) {
      session.close();
      await stop();
      sessionRef.current = null;
      transportRef.current = null;
      setConnectionState('error');
      connectingRef.current = false;
      setErrorMessage(String(error));
    }
  }, [
    appendActivity,
    playPcm,
    start,
    stop,
    stopPlayback,
  ]);

  const disconnect = useCallback(async () => {
    connectingRef.current = false;
    sessionRef.current?.close();
    sessionRef.current = null;
    transportRef.current = null;
    await stop();
    setConnectionState('disconnected');
    setMacStatus({ enabled: false, connected: false });
    setConfirmation(null);
    setM2Names([]);
    setM2Options(null);
    setM2Scope([]);
    appendActivity({
      id: crypto.randomUUID(),
      kind: 'system',
      title: 'Session disconnected',
    });
  }, [appendActivity, stop]);

  useEffect(() => () => {
    sessionRef.current?.close();
  }, []);

  const interrupt = useCallback(() => {
    sessionRef.current?.interrupt();
    stopPlayback();
  }, [stopPlayback]);

  const toggleCamera = useCallback(async () => {
    try {
      await setCamera(!cameraEnabled);
    } catch (error) {
      setErrorMessage(String(error));
    }
  }, [cameraEnabled, setCamera]);

  const conversationItems = useMemo(() => history.filter(
    (item): item is ConversationItem =>
      item.type === 'function_call'
      || (item.type === 'message' && item.role !== 'system'),
  ), [history]);

  const handleConversationScroll = useCallback(() => {
    const container = conversationScrollRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    followConversationRef.current = distanceFromBottom <= 72;
  }, []);

  useEffect(() => {
    const container = conversationScrollRef.current;
    if (!container || !followConversationRef.current) return;
    const frame = requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationItems]);

  const connected = connectionState === 'connected';
  const availableMacTools = connected
    ? [...(macStatus.connected ? ['demo_echo'] : []), ...m2Names]
    : [];
  const macOnline = availableMacTools.length > 0;
  const macConnectionLabel = !connected ? 'Offline'
    : macOnline ? 'Online'
    : macStatus.device_id ? 'Waiting for Mac'
    : macStatus.enabled ? 'Not paired' : 'Unavailable';
  const macStatusColor = macOnline ? 'text-[#248a52]'
    : connected && macStatus.device_id ? 'text-[#9a6825]' : 'text-[#68717d]';

  return (
    <main className="min-h-screen bg-[#f3f5f7] text-[#17202a]">
      <header className="border-b border-[#d8dde3] bg-white">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-[#15191e] text-white">
              <Radio size={18} aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-base font-semibold">Duplex MiMo Agent</h1>
              <p className="text-xs text-[#68717d]">VAD-gated audio and video session</p>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="text-[#68717d]">Agent</span>
            <strong className="max-w-36 truncate rounded bg-[#e8edf2] px-2 py-1 font-medium">
              {currentAgent}
            </strong>
            <span
              className={
                'ml-2 h-2.5 w-2.5 rounded-full '
                + (connected ? 'bg-[#248a52]' : 'bg-[#a9b0b8]')
              }
              aria-label={connectionState}
            />
            <span className="capitalize text-[#4f5965]">{connectionState}</span>
            <div
              role="status"
              aria-label={`Mac tools ${macConnectionLabel}`}
              title={availableMacTools.join(', ') || macConnectionLabel}
              className={`flex items-center gap-2 border-l border-[#d8dde3] pl-3 ${macStatusColor}`}
            >
              <Monitor size={16} aria-hidden="true" />
              <span className="h-2 w-2 shrink-0 rounded-full bg-current" aria-hidden="true" />
              <span>Mac tools <strong className="font-semibold">{macConnectionLabel}</strong></span>
              {macOnline && <span className="text-xs">({availableMacTools.length})</span>}
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1500px] gap-4 px-5 py-4 lg:grid-cols-[260px_minmax(0,1fr)_340px]">
        <aside className="border border-[#d8dde3] bg-white">
          <div className="border-b border-[#e2e6ea] px-4 py-3">
            <h2 className="text-sm font-semibold">Session Controls</h2>
          </div>
          <div className="space-y-5 p-4">
            <button
              type="button"
              onClick={connected ? disconnect : connect}
              disabled={connectionState === 'connecting'}
              className={
                'flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium text-white '
                + (connected
                  ? 'bg-[#b43b3b] hover:bg-[#9d3030]'
                  : 'bg-[#1f6f50] hover:bg-[#195d43]')
              }
            >
              {connected ? <PhoneOff size={17} /> : <Phone size={17} />}
              {connected ? 'Disconnect' : connectionState === 'connecting' ? 'Connecting' : 'Connect'}
            </button>

            <div>
              <div className="mb-2 flex items-center justify-between text-xs text-[#68717d]">
                <span className="flex items-center gap-1.5">
                  {mediaState === 'active' ? <Mic size={14} /> : <MicOff size={14} />}
                  Microphone
                </span>
                <span className="capitalize">{mediaState}</span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-[#e6eaee]">
                <div
                  className="h-full bg-[#2c8a62] transition-[width]"
                  style={{ width: `${Math.min(100, inputLevel * 220)}%` }}
                />
              </div>
            </div>

            <button
              type="button"
              onClick={interrupt}
              disabled={!connected}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#cfd5db] bg-white text-sm hover:bg-[#f2f4f6] disabled:opacity-40"
            >
              <CircleStop size={16} />
              Interrupt response
            </button>

            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2">
                <Volume2 size={16} />
                Audio playback
              </span>
              <input
                type="checkbox"
                checked={audioEnabled}
                onChange={(event) => {
                  audioEnabledRef.current = event.target.checked;
                  setAudioEnabled(event.target.checked);
                  if (!event.target.checked) stopPlayback();
                }}
                className="h-4 w-4"
              />
            </label>

            <button
              type="button"
              onClick={toggleCamera}
              disabled={!connected}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#cfd5db] bg-white text-sm hover:bg-[#f2f4f6] disabled:opacity-40"
            >
              {cameraEnabled ? <CameraOff size={16} /> : <Camera size={16} />}
              {cameraEnabled ? 'Disable camera' : 'Enable camera'}
            </button>

            <div className="aspect-video overflow-hidden bg-[#171b20]">
              <video
                ref={videoRef}
                muted
                playsInline
                className="h-full w-full object-cover"
              />
            </div>

            <div className="space-y-2 border-t border-[#e2e6ea] pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">Mac tools</div>
                <div className={`flex items-center gap-1.5 text-xs font-semibold ${macStatusColor}`}>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-current" aria-hidden="true" />
                  {macConnectionLabel}
                </div>
              </div>
              <div className="break-words text-xs text-[#68717d]">
                {macStatus.device_id || 'No device'}
              </div>
              {macOnline && (
                <div className="break-words text-xs text-[#248a52]">
                  {availableMacTools.join(', ')}
                </div>
              )}
              <input
                aria-label="Mac pairing code"
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value)}
                placeholder="Pairing code"
                disabled={!connected || !macStatus.enabled}
                autoComplete="off"
                className="h-9 w-full min-w-0 rounded-md border border-[#cfd5db] px-2 text-sm"
              />
              <button
                type="button"
                disabled={!connected || !macStatus.enabled || !pairingCode.trim()
                  || Boolean(macStatus.device_id)}
                onClick={() => {
                  pendingRememberRef.current = rememberBrowser;
                  transportRef.current?.bindMac(pairingCode.trim());
                  setPairingCode('');
                }}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#cfd5db] text-sm disabled:opacity-40"
              >
                <Link size={16} /> Authorize Mac echo
              </button>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={rememberBrowser}
                  onChange={(event) => setRememberBrowser(event.target.checked)}
                  disabled={browserTrusted} />
                Remember this browser
              </label>
              {browserTrusted && (
                <button type="button" onClick={async () => {
                  try {
                    await browserGrant('forget');
                    setBrowserTrusted(false);
                  } catch (error) { setErrorMessage(String(error)); }
                }} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#cfd5db] text-sm">
                  <Unlink size={16} /> Forget browser
                </button>
              )}
              <button
                type="button"
                disabled={!connected || !macStatus.device_id}
                onClick={async () => {
                  try {
                    await browserGrant('forget');
                    setBrowserTrusted(false);
                    transportRef.current?.revokeMac();
                  } catch (error) { setErrorMessage(String(error)); }
                }}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#cfd5db] text-sm disabled:opacity-40"
              >
                <Unlink size={16} /> Revoke Mac
              </button>
              <button
                type="button"
                disabled={!connected || !macStatus.device_id}
                onClick={() => transportRef.current?.sendRaw({ type: 'agent.mac.m2.options' })}
                className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#cfd5db] text-sm disabled:opacity-40"
              >
                <Wrench size={16} /> Mac permissions
              </button>
              {m2Options && Object.entries(m2Options.groups).map(([group, names]) => {
                const allowed = names.filter((name) => m2Options.allowed_scope.includes(name));
                if (!allowed.length) return null;
                return (
                  <label key={group} className="flex items-center gap-2 text-sm">
                    <input type="checkbox"
                      checked={allowed.every((name) => m2Scope.includes(name))}
                      onChange={(event) => setM2Scope((current) => event.target.checked
                        ? [...new Set([...current, ...allowed])]
                        : current.filter((name) => !allowed.includes(name)))}
                    />
                    {{ timers: 'Timers', weather_travel: 'Weather & routes',
                      reminders: 'Apple Reminders', contacts_facetime: 'Contacts & FaceTime' }[group] ?? group}
                  </label>
                );
              })}
              {m2Options && (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox"
                      disabled={!m2Options.allowed_scope.includes('timer.events.receive')}
                      checked={m2Scope.includes('timer.events.receive')}
                      onChange={(event) => setM2Scope((current) => event.target.checked
                        ? [...new Set([...current, 'timer.events.receive'])]
                        : current.filter((name) => name !== 'timer.events.receive'))}
                    />
                    Timer notifications
                  </label>
                  <button type="button" disabled={!connected || !m2Scope.length}
                    onClick={() => transportRef.current?.sendRaw({
                      type: 'agent.mac.m2.authorize', scope: m2Scope, confirmed: true,
                    })}
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#cfd5db] text-sm disabled:opacity-40">
                    <CheckCircle2 size={16} /> Authorize selected tools
                  </button>
                  <button type="button" disabled={!connected}
                    onClick={() => transportRef.current?.sendRaw({ type: 'agent.mac.m2.revoke' })}
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#cfd5db] text-sm">
                    <Unlink size={16} /> Revoke selected tools
                  </button>
                </>
              )}
              <div className="break-words text-xs text-[#68717d]">{m2Names.join(', ')}</div>
              {capturePaused && (
                <button type="button" disabled={!connected}
                  onClick={async () => {
                    if (!transportRef.current) return;
                    try {
                      await start(transportRef.current);
                      transportRef.current.sendRaw({ type: 'agent.capture.resume' });
                      capturePausedRef.current = false;
                      setCapturePaused(false);
                    } catch (error) {
                      setErrorMessage(String(error));
                    }
                  }}
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#cfd5db] text-sm">
                  <Mic size={16} /> Resume assistant
                </button>
              )}
            </div>
          </div>
        </aside>
        {confirmation && (
          <div role="dialog" aria-modal="true" aria-label="Confirm Mac operation"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
            <div className="w-full max-w-md rounded-md border border-[#cfd5db] bg-white p-4">
              <h2 className="text-base font-semibold">{confirmation.name}</h2>
              <pre className="my-4 max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm">
                {JSON.stringify(confirmation.arguments, null, 2)}
              </pre>
              <div className="flex justify-end gap-3">
                {[false, true].map((approved) => (
                  <button key={String(approved)} type="button"
                    onClick={() => {
                      transportRef.current?.sendRaw({
                        type: 'agent.mac.m2.confirm', call_id: confirmation.call_id, approved,
                      });
                      setConfirmation(null);
                    }}
                    className="flex h-9 items-center gap-2 rounded-md border border-[#cfd5db] px-3 text-sm">
                    {approved ? <CheckCircle2 size={16} /> : <CircleStop size={16} />}
                    {approved ? 'Confirm' : 'Cancel'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <section className="min-h-[72vh] border border-[#d8dde3] bg-white">
          <div className="flex items-center justify-between border-b border-[#e2e6ea] px-4 py-3">
            <h2 className="text-sm font-semibold">Conversation</h2>
            <span className="text-xs text-[#7a838d]">{conversationItems.length} items</span>
          </div>
          <div
            ref={conversationScrollRef}
            onScroll={handleConversationScroll}
            className="flex h-[calc(100vh-160px)] min-h-[560px] flex-col overflow-y-auto px-5 py-4"
          >
            {conversationItems.length === 0 ? (
              <div className="m-auto text-center text-sm text-[#7a838d]">
                <Mic className="mx-auto mb-3" size={24} />
                Connect and speak to begin.
              </div>
            ) : (
              <div className="space-y-4">
                {conversationItems.map((item) => {
                  if (item.type === 'function_call') {
                    const running = item.status === 'in_progress';
                    return (
                      <div key={item.itemId} className="mx-6">
                        <div
                          className={
                            'border px-3 py-3 '
                            + (running
                              ? 'border-[#dfc89f] bg-[#fff9ed]'
                              : 'border-[#bdd6c8] bg-[#f1f8f4]')
                          }
                        >
                          <div className="flex items-center gap-2">
                            {running ? (
                              <LoaderCircle
                                className="animate-spin text-[#9a6825]"
                                size={17}
                                aria-label="Tool running"
                              />
                            ) : (
                              <CheckCircle2
                                className="text-[#26734d]"
                                size={17}
                                aria-label="Tool completed"
                              />
                            )}
                            <Wrench size={15} className="text-[#59636e]" />
                            <span className="text-sm font-semibold">{item.name}</span>
                            <span className="ml-auto text-xs text-[#6f7882]">
                              {running ? 'Calling tool' : 'Tool completed'}
                            </span>
                          </div>

                          <div className="mt-3">
                            <div className="mb-1 text-xs font-medium uppercase text-[#7a838d]">
                              Arguments
                            </div>
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border border-[#e0e4e8] bg-white px-2 py-1.5 text-xs leading-5">
                              {formatJson(item.arguments) || '{}'}
                            </pre>
                          </div>

                          {running ? (
                            <div className="mt-3 flex items-center gap-2 text-xs text-[#8b642d]">
                              <LoaderCircle className="animate-spin" size={14} />
                              Waiting for the complete tool output...
                            </div>
                          ) : (
                            <div className="mt-3">
                              <div className="mb-1 text-xs font-medium uppercase text-[#7a838d]">
                                Output
                              </div>
                              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border border-[#d9e5de] bg-white px-2 py-1.5 text-xs leading-5">
                                {formatJson(item.output) || 'No output'}
                              </pre>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  const assistant = item.role === 'assistant';
                  const text = messageText(item);
                  return (
                    <div
                      key={item.itemId}
                      className={assistant ? 'mr-12' : 'ml-12'}
                    >
                      <div className="mb-1 text-xs font-medium uppercase text-[#7a838d]">
                        {assistant ? currentAgent : 'You'}
                      </div>
                      <div
                        className={
                          'border px-3 py-2 text-sm leading-6 '
                          + (assistant
                            ? 'border-[#d8dde3] bg-[#f7f8f9]'
                            : 'border-[#bfd8cc] bg-[#eef7f2]')
                        }
                      >
                        {text || (assistant ? 'Generating...' : 'Voice turn accepted')}
                        {item.status === 'incomplete' && (
                          <span className="ml-2 text-xs text-[#a14731]">Interrupted</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <aside className="border border-[#d8dde3] bg-white">
          <div className="border-b border-[#e2e6ea] px-4 py-3">
            <h2 className="text-sm font-semibold">Agent Activity</h2>
          </div>
          <div className="h-[calc(100vh-160px)] min-h-[560px] overflow-y-auto">
            {activity.length === 0 ? (
              <p className="px-4 py-5 text-sm text-[#7a838d]">No agent activity yet.</p>
            ) : activity.map((item) => (
              <div key={item.id} className="border-b border-[#edf0f2] px-4 py-3">
                <div className="flex items-start gap-2">
                  {item.kind === 'tool' ? (
                    <Wrench className="mt-0.5 text-[#8b5b24]" size={15} />
                  ) : item.kind === 'agent' ? (
                    <Radio className="mt-0.5 text-[#276d8a]" size={15} />
                  ) : (
                    <CircleStop className="mt-0.5 text-[#68717d]" size={15} />
                  )}
                  <div className="min-w-0">
                    <div className="break-words text-sm font-medium">{item.title}</div>
                    {item.detail && (
                      <div className="mt-1 break-words text-xs leading-5 text-[#68717d]">
                        {item.detail}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {errorMessage && (
        <div className="fixed bottom-4 left-1/2 max-w-[min(680px,calc(100vw-32px))] -translate-x-1/2 border border-[#d59c90] bg-[#fff4f1] px-4 py-3 text-sm text-[#8b3025]">
          {errorMessage}
        </div>
      )}
    </main>
  );
}
