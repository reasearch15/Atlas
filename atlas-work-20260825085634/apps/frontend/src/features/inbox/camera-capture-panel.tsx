"use client";

import { Camera, FlipHorizontal, RotateCcw, SendHorizontal, Square, Video, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { classifyMediaError, requestUserMedia, wasPermissionDeniedThisSession } from "./media-permissions";

export type CameraCaptureMode = "photo" | "video";

export interface CameraCaptureResult {
  readonly kind: CameraCaptureMode;
  readonly blob: Blob;
  readonly mimeType: string;
  readonly fileName: string;
  readonly objectUrl: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly forceDocument: boolean;
  readonly caption: string;
}

interface CameraCapturePanelProps {
  readonly disabled?: boolean;
  readonly uploading?: boolean;
  readonly uploadProgress?: number;
  readonly error?: string | null;
  readonly onSend: (capture: CameraCaptureResult) => Promise<void>;
  readonly onCancel: () => void;
  readonly onFallbackFile: () => void;
}

const MAX_VIDEO_SECONDS = 120;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * Compact in-composer camera panel for photo capture and short video recording.
 */
export function CameraCapturePanel({
  disabled,
  uploading,
  uploadProgress = 0,
  error,
  onSend,
  onCancel,
  onFallbackFile
}: CameraCapturePanelProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const previewUrlRef = useRef<string | null>(null);
  const [mode, setMode] = useState<CameraCaptureMode>("photo");
  const [facingMode, setFacingMode] = useState<"user" | "environment">("environment");
  const [canSwitch, setCanSwitch] = useState(false);
  const [liveReady, setLiveReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [preview, setPreview] = useState<CameraCaptureResult | null>(null);
  const [caption, setCaption] = useState("");
  const [sendAsFile, setSendAsFile] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (wasPermissionDeniedThisSession("camera")) {
        const mapped = classifyMediaError("camera", Object.assign(new Error("denied"), { name: "NotAllowedError" }));
        setLocalError(mapped.message);
        return;
      }
      try {
        await startStream(facingMode);
        if (cancelled) stopStream();
      } catch (startError) {
        const mapped = classifyMediaError("camera", startError);
        setLocalError(mapped.message);
      }
    })();
    void navigator.mediaDevices?.enumerateDevices?.().then((devices) => {
      const cameras = devices.filter((device) => device.kind === "videoinput");
      setCanSwitch(cameras.length > 1);
    });
    return () => {
      cancelled = true;
      stopRecorder();
      stopStream();
      revokePreview();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_VIDEO_SECONDS) {
        void stopVideoRecording();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  async function startStream(facing: "user" | "environment", forMode: CameraCaptureMode = mode): Promise<void> {
    stopStream();
    setLiveReady(false);
    const stream = await requestUserMedia("camera", {
      audio: forMode === "video",
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => undefined);
    }
    setLiveReady(true);
    setLocalError(null);
  }

  function stopStream(): void {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLiveReady(false);
  }

  function stopRecorder(): void {
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    } catch {
      // Ignore.
    }
    recorderRef.current = null;
  }

  function revokePreview(): void {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }

  async function switchCamera(): Promise<void> {
    const next = facingMode === "environment" ? "user" : "environment";
    setFacingMode(next);
    try {
      await startStream(next);
    } catch (switchError) {
      setLocalError(classifyMediaError("camera", switchError).message);
    }
  }

  async function changeMode(next: CameraCaptureMode): Promise<void> {
    setMode(next);
    setPreview(null);
    revokePreview();
    setCaption("");
    setSendAsFile(false);
    try {
      await startStream(facingMode, next);
    } catch (modeError) {
      setLocalError(classifyMediaError("camera", modeError).message);
    }
  }

  async function capturePhoto(): Promise<void> {
    const video = videoRef.current;
    if (!video || !liveReady) return;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      setLocalError("Unable to capture photo.");
      return;
    }
    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
      setLocalError("Unable to encode photo.");
      return;
    }
    revokePreview();
    const objectUrl = URL.createObjectURL(blob);
    previewUrlRef.current = objectUrl;
    setPreview({
      kind: "photo",
      blob,
      mimeType: "image/jpeg",
      fileName: `camera-${Date.now()}.jpg`,
      objectUrl,
      width,
      height,
      forceDocument: false,
      caption: ""
    });
    stopStream();
  }

  async function startVideoRecording(): Promise<void> {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const mimeType = pickVideoMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.start(200);
    setElapsed(0);
    setRecording(true);
  }

  async function stopVideoRecording(): Promise<void> {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.onerror = () => reject(new Error("Video recording failed"));
      recorder.onstop = () => {
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType || pickVideoMimeType() }));
      };
      recorder.stop();
    });
    setRecording(false);
    recorderRef.current = null;
    if (blob.size > MAX_VIDEO_BYTES) {
      setLocalError("Video exceeds the size limit.");
      return;
    }
    if (elapsed < 1 && blob.size < 1024) {
      setLocalError("Video is too short.");
      return;
    }
    const mimeType = blob.type || pickVideoMimeType();
    const video = videoRef.current;
    revokePreview();
    const objectUrl = URL.createObjectURL(blob);
    previewUrlRef.current = objectUrl;
    setPreview({
      kind: "video",
      blob,
      mimeType,
      fileName: mimeType.includes("mp4") ? `camera-${Date.now()}.mp4` : `camera-${Date.now()}.webm`,
      objectUrl,
      ...(video?.videoWidth ? { width: video.videoWidth } : {}),
      ...(video?.videoHeight ? { height: video.videoHeight } : {}),
      durationSeconds: Math.max(1, elapsed),
      forceDocument: false,
      caption: ""
    });
    stopStream();
  }

  async function retake(): Promise<void> {
    setPreview(null);
    revokePreview();
    setCaption("");
    setSendAsFile(false);
    setElapsed(0);
    try {
      await startStream(facingMode);
    } catch (retakeError) {
      setLocalError(classifyMediaError("camera", retakeError).message);
    }
  }

  function handleCancel(): void {
    stopRecorder();
    stopStream();
    revokePreview();
    onCancel();
  }

  const displayError = error || localError;
  const busy = Boolean(disabled || uploading || recording);

  if (displayError && !liveReady && !preview) {
    return (
      <div className="rounded-xl border bg-muted/40 px-3 py-3">
        <p className="text-sm text-red-600" role="alert">
          {displayError}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" variant="secondary" className="h-8 px-3 text-xs" onClick={onFallbackFile}>
            Choose file instead
          </Button>
          <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={handleCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-muted/40 px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex gap-1 rounded-md bg-white p-0.5 text-xs">
          <button
            type="button"
            className={`rounded px-2 py-1 ${mode === "photo" ? "bg-[#229ED9] text-white" : "text-muted-foreground"}`}
            onClick={() => void changeMode("photo")}
            disabled={busy || Boolean(preview)}
          >
            Photo
          </button>
          <button
            type="button"
            className={`rounded px-2 py-1 ${mode === "video" ? "bg-[#229ED9] text-white" : "text-muted-foreground"}`}
            onClick={() => void changeMode("video")}
            disabled={busy || Boolean(preview)}
          >
            Video
          </button>
        </div>
        <button type="button" className="rounded-full p-1 text-muted-foreground hover:bg-muted" aria-label="Close camera" onClick={handleCancel}>
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {preview ? (
        <div>
          {preview.kind === "photo" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview.objectUrl} alt="" className="max-h-56 w-full rounded-md object-contain bg-black/5" />
          ) : (
            <video src={preview.objectUrl} className="max-h-56 w-full rounded-md bg-black object-contain" controls playsInline />
          )}
          <input
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Add a caption…"
            disabled={busy}
            className="mt-2 w-full rounded-md border bg-white px-2 py-1 text-sm outline-none disabled:opacity-60"
            aria-label="Capture caption"
          />
          {preview.kind === "video" ? (
            <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={sendAsFile} disabled={busy} onChange={(event) => setSendAsFile(event.target.checked)} />
              Send as file
            </label>
          ) : null}
          {uploading ? (
            <div className="mt-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
                <div className="h-full bg-[#229ED9] transition-[width]" style={{ width: `${Math.round(uploadProgress * 100)}%` }} />
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">Uploading {Math.round(uploadProgress * 100)}%</p>
            </div>
          ) : null}
          {displayError ? (
            <p className="mt-1 text-xs text-red-600" role="alert">
              {displayError}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={handleCancel} disabled={uploading}>
              Cancel
            </Button>
            <Button type="button" variant="secondary" className="h-8 px-3 text-xs" onClick={() => void retake()} disabled={uploading}>
              <RotateCcw className="mr-1 size-3.5" aria-hidden="true" />
              Retake
            </Button>
            <Button
              type="button"
              className="h-8 px-3 text-xs"
              disabled={uploading}
              onClick={() =>
                void onSend({
                  ...preview,
                  caption,
                  forceDocument: preview.kind === "video" ? sendAsFile : false
                })
              }
            >
              <SendHorizontal className="mr-1 size-3.5" aria-hidden="true" />
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <div className="relative overflow-hidden rounded-md bg-black">
            <video ref={videoRef} className="max-h-56 w-full object-contain" muted playsInline autoPlay />
            {recording ? (
              <span className="absolute left-2 top-2 rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white">
                REC {formatClock(elapsed)}
              </span>
            ) : null}
          </div>
          {displayError ? (
            <p className="mt-1 text-xs text-red-600" role="alert">
              {displayError}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {canSwitch ? (
              <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={() => void switchCamera()} disabled={busy}>
                <FlipHorizontal className="mr-1 size-3.5" aria-hidden="true" />
                Flip
              </Button>
            ) : null}
            {mode === "photo" ? (
              <Button type="button" className="h-8 px-3 text-xs" onClick={() => void capturePhoto()} disabled={!liveReady || busy}>
                <Camera className="mr-1 size-3.5" aria-hidden="true" />
                Capture
              </Button>
            ) : recording ? (
              <Button type="button" variant="secondary" className="h-8 px-3 text-xs" onClick={() => void stopVideoRecording()}>
                <Square className="mr-1 size-3.5" aria-hidden="true" />
                Stop
              </Button>
            ) : (
              <Button type="button" className="h-8 px-3 text-xs" onClick={() => void startVideoRecording()} disabled={!liveReady || busy}>
                <Video className="mr-1 size-3.5" aria-hidden="true" />
                Record
              </Button>
            )}
            <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={onFallbackFile} disabled={busy}>
              File instead
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function pickVideoMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "video/webm";
  const candidates = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "video/webm";
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
