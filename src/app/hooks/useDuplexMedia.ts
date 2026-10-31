'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DuplexMiMoTransport,
  DuplexMiMoVideoFrame,
} from '../lib/DuplexMiMoTransport';

const AUDIO_CHUNK_MS = 500;
const VIDEO_INTERVAL_MS = 1000;

type MediaState = 'idle' | 'starting' | 'active' | 'error';

export function useDuplexMedia() {
  const [mediaState, setMediaState] = useState<MediaState>('idle');
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const cameraEnabledRef = useRef(false);
  const [inputLevel, setInputLevel] = useState(0);
  const transportRef = useRef<DuplexMiMoTransport | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const inputStreamRef = useRef<MediaStream | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | null>(null);
  const pendingRef = useRef<Int16Array[]>([]);
  const pendingSamplesRef = useRef(0);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastVideoAtRef = useRef(0);
  const outputContextRef = useRef<AudioContext | null>(null);
  const outputCursorRef = useRef(0);
  const outputSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const captureVideoFrame = useCallback((): DuplexMiMoVideoFrame | undefined => {
    const video = videoRef.current;
    const now = performance.now();
    if (
      !cameraEnabledRef.current
      || !video
      || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      || now - lastVideoAtRef.current < VIDEO_INTERVAL_MS
    ) {
      return undefined;
    }
    const width = Math.min(video.videoWidth || 640, 960);
    const sourceWidth = video.videoWidth || width;
    const sourceHeight = video.videoHeight || 540;
    const height = Math.max(1, Math.round(sourceHeight * width / sourceWidth));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(video, 0, 0, width, height);
    const url = canvas.toDataURL('image/jpeg', 0.78);
    lastVideoAtRef.current = now;
    return { format: 'jpeg', data: url.split(',', 2)[1] };
  }, []);

  const flushAudio = useCallback(() => {
    const context = inputContextRef.current;
    const transport = transportRef.current;
    if (!context || !transport || pendingSamplesRef.current === 0) return;
    const merged = new Int16Array(pendingSamplesRef.current);
    let offset = 0;
    for (const chunk of pendingRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    pendingRef.current = [];
    pendingSamplesRef.current = 0;
    transport.sendAudioWithVideo(
      merged.buffer,
      captureVideoFrame(),
    );
  }, [captureVideoFrame]);

  const start = useCallback(async (transport: DuplexMiMoTransport) => {
    if (mediaState === 'starting' || mediaState === 'active') return;
    setMediaState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const context = new AudioContext();
      transport.setInputSampleRate(context.sampleRate);
      await context.audioWorklet.addModule('/duplex_pcm_capture.js');
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(context, 'duplex-pcm-capture');
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(capture).connect(silentGain).connect(context.destination);
      const targetSamples = Math.round(context.sampleRate * AUDIO_CHUNK_MS / 1000);
      capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const chunk = new Int16Array(event.data);
        pendingRef.current.push(chunk);
        pendingSamplesRef.current += chunk.length;
        let peak = 0;
        for (let index = 0; index < chunk.length; index += 1) {
          peak = Math.max(peak, Math.abs(chunk[index]));
        }
        setInputLevel(peak / 32768);
        if (pendingSamplesRef.current >= targetSamples) flushAudio();
      };
      transportRef.current = transport;
      inputContextRef.current = context;
      inputStreamRef.current = stream;
      captureNodeRef.current = capture;
      setMediaState('active');
    } catch (error) {
      console.error('Unable to start duplex media', error);
      setMediaState('error');
      throw error;
    }
  }, [flushAudio, mediaState]);

  const stopCamera = useCallback(() => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    cameraEnabledRef.current = false;
    setCameraEnabled(false);
  }, []);

  const setCamera = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      stopCamera();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 15 } },
    });
    cameraStreamRef.current = stream;
    cameraEnabledRef.current = true;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
    setCameraEnabled(true);
  }, [stopCamera]);

  const stopPlayback = useCallback(() => {
    for (const source of outputSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Source may already have ended.
      }
    }
    outputSourcesRef.current.clear();
    outputCursorRef.current = 0;
    transportRef.current?.setPlaybackActive(false);
  }, []);

  const playPcm = useCallback(async (pcm: ArrayBuffer, sampleRate = 24000) => {
    let context = outputContextRef.current;
    if (!context) {
      context = new AudioContext();
      outputContextRef.current = context;
    }
    await context.resume();
    const samples = new Int16Array(pcm);
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    const output = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      output[index] = samples[index] / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const first = outputSourcesRef.current.size === 0;
    const startAt = Math.max(context.currentTime + 0.02, outputCursorRef.current);
    outputCursorRef.current = startAt + buffer.duration;
    outputSourcesRef.current.add(source);
    if (first) transportRef.current?.setPlaybackActive(true);
    source.onended = () => {
      outputSourcesRef.current.delete(source);
      if (outputSourcesRef.current.size === 0) {
        outputCursorRef.current = 0;
        transportRef.current?.setPlaybackActive(false);
      }
    };
    source.start(startAt);
  }, []);

  const stop = useCallback(async () => {
    flushAudio();
    captureNodeRef.current?.disconnect();
    captureNodeRef.current = null;
    inputStreamRef.current?.getTracks().forEach((track) => track.stop());
    inputStreamRef.current = null;
    await inputContextRef.current?.close();
    inputContextRef.current = null;
    pendingRef.current = [];
    pendingSamplesRef.current = 0;
    stopCamera();
    stopPlayback();
    transportRef.current = null;
    setInputLevel(0);
    setMediaState('idle');
  }, [flushAudio, stopCamera, stopPlayback]);

  useEffect(() => () => {
    void stop();
  }, [stop]);

  return {
    mediaState,
    cameraEnabled,
    inputLevel,
    videoRef,
    start,
    stop,
    setCamera,
    playPcm,
    stopPlayback,
  };
}
