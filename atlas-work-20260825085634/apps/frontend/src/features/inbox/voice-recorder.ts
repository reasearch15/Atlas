import { classifyMediaError, requestUserMedia, type MediaPermissionState } from "./media-permissions";

export type VoiceRecorderPhase = "idle" | "recording" | "preview" | "uploading" | "sending" | "sent" | "failed";

export const MAX_VOICE_DURATION_SECONDS = 300;
export const MAX_VOICE_BYTES = 20 * 1024 * 1024;

export interface VoiceRecordingResult {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly fileName: string;
  readonly durationSeconds: number;
  readonly waveform: number[];
  readonly objectUrl: string;
}

/**
 * Picks the best MediaRecorder MIME type available in this browser.
 */
export function pickVoiceMimeType(
  isTypeSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)
): string {
  const candidates = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const type of candidates) {
    if (isTypeSupported(type)) return type;
  }
  return "audio/webm";
}

/**
 * Maps a recorder MIME type to a Telegram-friendly filename extension.
 */
export function voiceFileNameForMime(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime.includes("ogg")) return `voice-${Date.now()}.ogg`;
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return `voice-${Date.now()}.m4a`;
  return `voice-${Date.now()}.webm`;
}

/**
 * Downsamples analyser peaks into Telegram-style 0–31 waveform bars.
 */
export function buildWaveformFromPeaks(peaks: readonly number[], barCount = 64): number[] {
  if (peaks.length === 0) return Array.from({ length: Math.min(barCount, 32) }, () => 1);
  const count = Math.max(8, Math.min(barCount, 100));
  const bucketSize = peaks.length / count;
  const bars: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * bucketSize);
    const end = Math.max(start + 1, Math.floor((index + 1) * bucketSize));
    let max = 0;
    for (let i = start; i < end && i < peaks.length; i += 1) {
      max = Math.max(max, peaks[i] ?? 0);
    }
    bars.push(Math.max(0, Math.min(31, Math.round(max * 31))));
  }
  return bars;
}

/**
 * Validates a recorded voice blob before upload.
 */
export function validateVoiceRecording(input: {
  readonly blob: Blob;
  readonly durationSeconds: number;
  readonly maxBytes?: number;
  readonly maxDurationSeconds?: number;
}): string | null {
  if (input.durationSeconds < 1) return "Recording is too short.";
  if (input.durationSeconds > (input.maxDurationSeconds ?? MAX_VOICE_DURATION_SECONDS)) {
    return "Recording is too long.";
  }
  if (input.blob.size <= 0) return "Recording is empty.";
  if (input.blob.size > (input.maxBytes ?? MAX_VOICE_BYTES)) return "Recording exceeds the size limit.";
  const mime = (input.blob.type || "").toLowerCase();
  if (mime && !mime.startsWith("audio/") && !mime.includes("ogg") && !mime.includes("webm") && !mime.includes("mp4")) {
    return "Unsupported audio format.";
  }
  return null;
}

/**
 * Controller for click / hold-to-record voice capture. Blobs stay in memory only.
 */
export class VoiceRecorderController {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private peaks: number[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId: number | null = null;
  private startedAt = 0;
  private objectUrl: string | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  public async start(): Promise<{ readonly mimeType: string }> {
    this.cleanupRecordingGraph(false);
    const stream = await requestUserMedia("microphone", {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1
      }
    });
    this.stream = stream;
    const mimeType = pickVoiceMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder = recorder;
    this.chunks = [];
    this.peaks = [];
    this.startedAt = Date.now();

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };

    this.attachAnalyser(stream);
    recorder.start(120);
    this.stopTimer = setTimeout(() => {
      void this.stop().catch(() => undefined);
    }, MAX_VOICE_DURATION_SECONDS * 1000);

    return { mimeType: recorder.mimeType || mimeType };
  }

  public async stop(): Promise<VoiceRecordingResult> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") {
      throw new Error("Recorder is not active");
    }
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    const durationSeconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.onerror = () => reject(new Error("Recording failed"));
      recorder.onstop = () => {
        const type = recorder.mimeType || pickVoiceMimeType();
        resolve(new Blob(this.chunks, { type }));
      };
      try {
        recorder.stop();
      } catch (error) {
        reject(error);
      }
    });

    this.stopTracks();
    this.stopAnalyser();

    const mimeType = blob.type || pickVoiceMimeType();
    this.revokeObjectUrl();
    const objectUrl = URL.createObjectURL(blob);
    this.objectUrl = objectUrl;
    const waveform = buildWaveformFromPeaks(this.peaks);
    const validationError = validateVoiceRecording({ blob, durationSeconds });
    if (validationError) {
      this.revokeObjectUrl();
      throw new Error(validationError);
    }

    return {
      blob,
      mimeType,
      fileName: voiceFileNameForMime(mimeType),
      durationSeconds,
      waveform,
      objectUrl
    };
  }

  public cancel(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // Ignore stop races.
    }
    this.cleanupRecordingGraph(true);
  }

  public getLiveLevel(): number {
    if (this.peaks.length === 0) return 0;
    return this.peaks[this.peaks.length - 1] ?? 0;
  }

  public getLivePeaks(): number[] {
    return this.peaks.slice(-48);
  }

  public revokeObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  public mapStartError(error: unknown): { readonly state: MediaPermissionState; readonly message: string } {
    return classifyMediaError("microphone", error);
  }

  private attachAnalyser(stream: MediaStream): void {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const context = new AudioCtx();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.audioContext = context;
    this.analyser = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = (): void => {
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const centered = ((data[i] ?? 128) - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / data.length);
      this.peaks.push(Math.min(1, rms * 4));
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopAnalyser(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    this.analyser = null;
  }

  private stopTracks(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
  }

  private cleanupRecordingGraph(revokePreview: boolean): void {
    this.stopAnalyser();
    this.stopTracks();
    this.chunks = [];
    if (revokePreview) this.revokeObjectUrl();
  }
}
