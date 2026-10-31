import {
  OpenAIRealtimeBase,
  type RealtimeClientMessage,
  type RealtimeItem,
  type RealtimeSessionConfig,
  type RealtimeTransportLayerConnectOptions,
  type TransportToolCallEvent,
} from '@openai/agents/realtime';

type DuplexMiMoTransportOptions = {
  url: string;
  configure?: Record<string, unknown>;
  sampleRateHz?: number;
};

export type DuplexMiMoVideoFrame = {
  format: 'jpeg';
  data: string;
};

export class DuplexMiMoTransport extends OpenAIRealtimeBase {
  private socket: WebSocket | null = null;
  private connectionStatus:
    | 'connected'
    | 'disconnected'
    | 'connecting'
    | 'disconnecting' = 'disconnected';
  private readonly url: string;
  private readonly configure: Record<string, unknown>;
  private sampleRateHz: number;
  private mutedState = false;
  private currentResponseId: string | null = null;
  private currentItemId: string | null = null;
  private currentText = '';

  constructor(options: DuplexMiMoTransportOptions) {
    super();
    this.url = options.url;
    this.configure = options.configure ?? {};
    this.sampleRateHz = options.sampleRateHz ?? 16_000;
  }

  get status() {
    return this.connectionStatus;
  }

  get muted() {
    return this.mutedState;
  }

  async connect(options: RealtimeTransportLayerConnectOptions): Promise<void> {
    if (this.socket) return;
    this.connectionStatus = 'connecting';
    this.emit('connection_change', 'connecting');
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(options.url ?? this.url);
      this.socket = socket;
      socket.addEventListener('open', () => {
        this.connectionStatus = 'connected';
        this.emit('connection_change', 'connected');
        this.sendJson({ type: 'configure', ...this.configure });
        if (options.initialSessionConfig) {
          this.updateSessionConfig(options.initialSessionConfig);
        }
        resolve();
      });
      socket.addEventListener('message', (event) => {
        try {
          this.handleServerEvent(JSON.parse(String(event.data)));
        } catch (error) {
          this.emit('error', { type: 'error', error });
        }
      });
      socket.addEventListener('error', (error) => {
        this.emit('error', { type: 'error', error });
        reject(error);
      });
      socket.addEventListener('close', () => {
        this.socket = null;
        this.connectionStatus = 'disconnected';
        this.emit('connection_change', 'disconnected');
      });
    });
  }

  sendEvent(event: RealtimeClientMessage): void {
    switch (event.type) {
      case 'session.update':
        this.sendAgentSession(event.session ?? {});
        return;
      case 'input_audio_buffer.append':
        if (!this.mutedState) {
          this.sendJson({
            type: 'audio',
            audio: event.audio,
            format: 'pcm16',
            sample_rate_hz: this.sampleRateHz,
            ...(event.video_frame ? { video_frame: event.video_frame } : {}),
          });
        }
        return;
      case 'input_audio_buffer.clear':
      case 'input_audio_buffer.commit':
      case 'response.create':
        return;
      case 'conversation.item.create':
        if (event.item?.type === 'function_call_output') {
          this.sendJson({
            type: 'agent.function_call_output',
            call_id: event.item.call_id,
            output: event.item.output,
          });
          return;
        }
        throw new Error('Unsupported duplex MiMo conversation item: ' + event.item?.type);
      case 'response.cancel':
        this.sendJson({ type: 'response.cancel' });
        return;
      default:
        throw new Error('Unsupported duplex MiMo client event: ' + event.type);
    }
  }

  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void {
    this.sendAgentSession(config);
  }

  sendFunctionCallOutput(
    toolCall: TransportToolCallEvent,
    output: string,
    _startResponse = true,
  ): void {
    void _startResponse;
    this.sendJson({
      type: 'agent.function_call_output',
      call_id: toolCall.callId,
      output,
    });
    this.emit('item_update', {
      itemId: toolCall.id ?? toolCall.callId,
      previousItemId: toolCall.previousItemId,
      type: 'function_call',
      status: 'completed',
      arguments: toolCall.arguments,
      name: toolCall.name,
      output,
    });
  }

  sendMessage(): void {
    throw new Error('Text input is not enabled for the duplex MiMo transport');
  }

  sendAudio(audio: ArrayBuffer): void {
    this.sendAudioWithVideo(audio);
  }

  setInputSampleRate(sampleRateHz: number): void {
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
      throw new Error('Input sample rate must be positive');
    }
    this.sampleRateHz = Math.round(sampleRateHz);
  }

  sendAudioWithVideo(
    audio: ArrayBuffer,
    videoFrame?: DuplexMiMoVideoFrame,
  ): void {
    if (this.mutedState || this.connectionStatus !== 'connected') return;
    const bytes = new Uint8Array(audio);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: btoa(binary),
      ...(videoFrame ? { video_frame: videoFrame } : {}),
    });
  }

  setPlaybackActive(active: boolean): void {
    this.sendJson({ type: 'playback.state', active });
  }

  mute(muted: boolean): void {
    this.mutedState = muted;
  }

  interrupt(): void {
    this.sendJson({ type: 'response.cancel' });
    this.emit('audio_interrupted');
  }

  resetHistory(_oldHistory: RealtimeItem[], _newHistory: RealtimeItem[]): void {
    void _oldHistory;
    void _newHistory;
    this.sendJson({ type: 'reset' });
  }

  close(): void {
    if (!this.socket) return;
    this.connectionStatus = 'disconnecting';
    this.socket.close();
  }

  private sendAgentSession(config: Partial<RealtimeSessionConfig>) {
    if (!config.instructions) return;
    const tools = (config.tools ?? []).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    this.sendJson({
      type: 'agent.session.update',
      instructions: config.instructions,
      tools,
    });
  }

  private sendJson(payload: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Duplex MiMo transport is not connected');
    }
    this.socket.send(JSON.stringify(payload));
  }

  private handleServerEvent(event: Record<string, any>) {
    this.emit('*', event as any);
    switch (event.type) {
      case 'chat.started':
        this.currentResponseId = 'response-' + event.turn_id;
        this.currentItemId = 'assistant-' + event.turn_id;
        this.currentText = '';
        this.emit('item_update', {
          itemId: 'user-' + event.turn_id,
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{
            type: 'input_audio',
            audio: null,
            transcript: null,
          }],
        });
        this.emit('turn_started', {
          type: 'response_started',
          response: { id: this.currentResponseId },
        } as any);
        return;
      case 'chat.delta':
        this.currentText += event.delta ?? '';
        this.emit('audio_transcript_delta', {
          type: 'transcript_delta',
          itemId: this.currentItemId!,
          responseId: this.currentResponseId!,
          delta: event.delta ?? '',
        });
        this.emitAssistantItem('in_progress');
        return;
      case 'chat.done':
        this.currentText = event.text ?? this.currentText;
        this.emitAssistantItem('completed');
        this.emit('turn_done', {
          type: 'response_completed',
          response: {
            id: this.currentResponseId,
            output: [this.assistantItem('completed')],
            usage: {},
          },
        } as any);
        return;
      case 'tts.audio':
        this.emit('audio', {
          type: 'audio',
          data: this.decodeBase64(event.pcm),
          responseId: this.currentResponseId ?? 'response-' + event.turn_id,
        });
        return;
      case 'tts.done':
        this.emit('audio_done');
        return;
      case 'chat.cancelled':
      case 'tts.cancelled':
        if (this.currentItemId && this.currentText) {
          if (event.retained && !this.currentText.endsWith('⏸')) {
            this.currentText += '⏸';
          }
          this.emit('item_update', this.assistantItem('incomplete'));
        }
        this.emit('audio_interrupted');
        return;
      case 'agent.function_call': {
        const item = {
          itemId: event.call_id,
          type: 'function_call' as const,
          status: 'in_progress' as const,
          arguments: event.arguments,
          name: event.name,
          output: null,
        };
        this.emit('item_update', item);
        this.emit('function_call', {
          id: event.call_id,
          type: 'function_call',
          name: event.name,
          callId: event.call_id,
          arguments: event.arguments,
        });
        return;
      }
      case 'error':
      case 'chat.error':
      case 'tts.error':
        this.emit('error', { type: 'error', error: new Error(event.message) });
        return;
    }
  }

  private emitAssistantItem(status: 'in_progress' | 'completed') {
    this.emit('item_update', this.assistantItem(status));
  }

  private assistantItem(status: 'in_progress' | 'completed' | 'incomplete') {
    return {
      itemId: this.currentItemId!,
      type: 'message' as const,
      role: 'assistant' as const,
      status,
      content: [{ type: 'audio' as const, transcript: this.currentText, audio: null }],
    };
  }

  private decodeBase64(value: string): ArrayBuffer {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }
}
