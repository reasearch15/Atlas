"use client";

import { Mic, Pause, RotateCcw, SendHorizontal, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  VoiceRecorderController,
  type VoiceRecorderPhase,
  type VoiceRecordingResult
} from "./voice-recorder";

interface VoiceRecorderPanelProps {
  readonly disabled?: boolean;
  readonly onSend: (recording: VoiceRecordingResult) => Promise<void>;
  readonly onCancel: () => void;
  readonly phase: VoiceRecorderPhase;
  readonly uploadProgress?: number;
  readonly error?: string | null;
}

/**
 * Voice recording UI: idle trigger lives in composer; this panel covers recording/preview/upload.
 */
export function VoiceRecorderPanel({
  disabled,
  onSend,
  onCancel,
  phase,
  uploadProgress = 0,
  error
}: VoiceRecorderPanelProps) {
  const controllerRef = useRef(new VoiceRecorderController());
  const [localPhase, setLocalPhase] = useState<"recording" | "preview">("recording");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [recording, setRecording] = useState<VoiceRecordingResult | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const holdRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await controllerRef.current.start();
        if (cancelled) {
          controllerRef.current.cancel();
          return;
        }
        setLocalPhase("recording");
      } catch (startError) {
        const mapped = controllerRef.current.mapStartError(startError);
        setLocalError(mapped.message);
        onCancel();
      }
    })();
    return () => {
      cancelled = true;
      controllerRef.current.cancel();
    };
    // Start once when the panel mounts after an explicit user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (localPhase !== "recording") return;
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
      setLevel(controllerRef.current.getLiveLevel());
      setPeaks(controllerRef.current.getLivePeaks());
    }, 80);
    return () => clearInterval(timer);
  }, [localPhase]);

  useEffect(() => {
    return () => {
      controllerRef.current.revokeObjectUrl();
    };
  }, []);

  async function stopRecording(): Promise<void> {
    try {
      const result = await controllerRef.current.stop();
      setRecording(result);
      setLocalPhase("preview");
      setLocalError(null);
    } catch (stopError) {
      setLocalError(stopError instanceof Error ? stopError.message : "Unable to finish recording.");
    }
  }

  async function reRecord(): Promise<void> {
    controllerRef.current.revokeObjectUrl();
    setRecording(null);
    setElapsed(0);
    setLocalError(null);
    try {
      await controllerRef.current.start();
      setLocalPhase("recording");
    } catch (startError) {
      const mapped = controllerRef.current.mapStartError(startError);
      setLocalError(mapped.message);
    }
  }

  function handleCancel(): void {
    controllerRef.current.cancel();
    controllerRef.current.revokeObjectUrl();
    onCancel();
  }

  const busy = phase === "uploading" || phase === "sending" || Boolean(disabled);
  const displayError = error || localError;

  return (
    <div className="rounded-xl border bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-[#229ED9]/15 text-[#229ED9]">
          <Mic className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          {localPhase === "recording" ? (
            <>
              <p className="text-sm font-medium text-red-600">Recording… {formatClock(elapsed)}</p>
              <WaveformBars peaks={peaks} level={level} />
            </>
          ) : (
            <>
              <p className="text-sm font-medium">Voice message · {formatClock(recording?.durationSeconds ?? elapsed)}</p>
              {recording ? (
                <audio src={recording.objectUrl} controls className="mt-1 h-8 w-full max-w-full" preload="metadata" />
              ) : null}
              <WaveformBars peaks={recording?.waveform.map((value) => value / 31) ?? peaks} level={0} />
            </>
          )}
          {phase === "uploading" || phase === "sending" ? (
            <div className="mt-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
                <div
                  className="h-full bg-[#229ED9] transition-[width]"
                  style={{ width: `${Math.round((phase === "sending" ? 1 : uploadProgress) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {phase === "sending" ? "Sending voice message…" : `Uploading ${Math.round(uploadProgress * 100)}%`}
              </p>
            </div>
          ) : null}
          {displayError ? (
            <p className="mt-1 text-xs text-red-600" role="alert">
              {displayError}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {localPhase === "recording" ? (
          <>
            <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={handleCancel} disabled={busy}>
              <Trash2 className="mr-1 size-3.5" aria-hidden="true" />
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="h-8 px-3 text-xs"
              onClick={() => void stopRecording()}
              onPointerUp={() => {
                if (holdRef.current) {
                  holdRef.current = false;
                  void stopRecording();
                }
              }}
              disabled={busy}
            >
              <Square className="mr-1 size-3.5" aria-hidden="true" />
              Stop
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={handleCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" variant="secondary" className="h-8 px-3 text-xs" onClick={() => void reRecord()} disabled={busy}>
              <RotateCcw className="mr-1 size-3.5" aria-hidden="true" />
              Re-record
            </Button>
            <Button
              type="button"
              className="h-8 px-3 text-xs"
              disabled={busy || !recording}
              onClick={() => {
                if (!recording) return;
                void onSend(recording);
              }}
            >
              {phase === "failed" ? <Pause className="mr-1 size-3.5" aria-hidden="true" /> : <SendHorizontal className="mr-1 size-3.5" aria-hidden="true" />}
              {phase === "failed" ? "Retry" : "Send"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function WaveformBars({ peaks, level }: { readonly peaks: number[]; readonly level: number }) {
  const bars = peaks.length > 0 ? peaks : [level, level * 0.7, level * 0.4];
  return (
    <div className="mt-1 flex h-6 items-end gap-[2px]" aria-hidden="true">
      {bars.slice(-32).map((value, index) => (
        <span
          key={index}
          className="w-[3px] rounded-sm bg-[#229ED9]/80"
          style={{ height: `${Math.max(12, Math.min(100, value * 100))}%` }}
        />
      ))}
    </div>
  );
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
