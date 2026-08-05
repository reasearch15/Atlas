"use client";

import type { TelegramMessageDto } from "@atlas/shared";
import { Camera, Mic, Paperclip, SendHorizontal, Smile, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@atlas/ui";
import { CameraCapturePanel, type CameraCaptureResult } from "./camera-capture-panel";
import {
  inferAttachmentContentType,
  mediaPreviewLabel,
  readImageDimensions,
  readVideoMetadata,
  uploadAndSendComposerMedia,
  formatComposerMediaError
} from "./composer-media-upload";
import { insertTextAtCursor } from "./emoji-catalog";
import { EmojiPicker } from "./emoji-picker";
import { formatFileSize } from "./media-message-helpers";
import { classifyMediaError, wasPermissionDeniedThisSession } from "./media-permissions";
import { VoiceRecorderPanel } from "./voice-recorder-panel";
import type { VoiceRecorderPhase, VoiceRecordingResult } from "./voice-recorder";

interface MessageComposerProps {
  readonly chatId: string;
  readonly disabled?: boolean;
  readonly sending?: boolean;
  readonly replyTo?: { readonly telegramMessageId: string; readonly preview: string } | null;
  readonly onClearReply?: () => void;
  readonly onSend: (text: string) => Promise<void> | void;
  readonly onMediaSent?: (message: TelegramMessageDto) => void;
  readonly onMediaActivity?: (previewText: string, sentAt: string) => void;
}

type UploadPhase = "idle" | "uploading" | "sending" | "error";
type SendAsMode = "photo" | "file";
type ComposerMode = "text" | "attachment" | "voice" | "camera";

const MAX_LINES = 6;
const LINE_HEIGHT_PX = 20;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Telegram-style message composer with emoji, voice, camera, attachments, and send.
 */
export function MessageComposer({
  chatId,
  disabled = false,
  sending = false,
  replyTo = null,
  onClearReply,
  onSend,
  onMediaSent,
  onMediaActivity
}: MessageComposerProps) {
  const [text, setText] = useState("");
  const [composerMode, setComposerMode] = useState<ComposerMode>("text");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [sendAs, setSendAs] = useState<SendAsMode>("photo");
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoiceRecorderPhase>("idle");
  const [permissionHint, setPermissionHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const emojiButtonRef = useRef<HTMLButtonElement | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const busy = disabled || sending || uploadPhase === "uploading" || uploadPhase === "sending" || voicePhase === "uploading" || voicePhase === "sending";
  const imageAttachment = Boolean(selectedFile && isImageFile(selectedFile));
  const canChooseSendAs = imageAttachment && !isGifFile(selectedFile);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    const maxHeight = LINE_HEIGHT_PX * MAX_LINES;
    node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`;
  }, [text]);

  useEffect(() => {
    if (!disabled && !sending && uploadPhase === "idle" && composerMode === "text") {
      textareaRef.current?.focus();
    }
  }, [disabled, sending, uploadPhase, composerMode]);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  function clearAttachment(): void {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setSelectedFile(null);
    setCaption("");
    setSendAs("photo");
    setUploadPhase("idle");
    setUploadProgress(0);
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (composerMode === "attachment") setComposerMode("text");
  }

  function resetSpecialModes(): void {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setComposerMode("text");
    setVoicePhase("idle");
    setUploadPhase("idle");
    setUploadProgress(0);
    setUploadError(null);
    setPermissionHint(null);
  }

  function insertEmoji(emoji: string): void {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const { next, caret } = insertTextAtCursor(text, emoji, start, end);
    setText(next);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.selectionStart = node.selectionEnd = caret;
    });
  }

  async function submitText(): Promise<void> {
    const value = text.trim();
    if (!value || busy) return;
    await onSend(value);
    setText("");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function submitMedia(file: File): Promise<void> {
    if (busy) return;
    const forceDocument = resolveForceDocument(file, sendAs);
    const contentType = forceDocument ? "DOCUMENT" : inferAttachmentContentType(file);
    const mimeType = file.type || "application/octet-stream";
    setUploadError(null);
    setUploadPhase("uploading");
    setUploadProgress(0);

    try {
      const dims = imageAttachment ? await readImageDimensions(file).catch(() => null) : null;
      const videoMeta =
        contentType === "VIDEO" ? await readVideoMetadata(file).catch(() => null) : null;
      const pending = await uploadAndSendComposerMedia(
        chatId,
        file,
        {
          contentType,
          mimeType,
          fileName: file.name || "attachment",
          forceDocument,
          ...(dims?.width ? { width: dims.width } : {}),
          ...(dims?.height ? { height: dims.height } : {}),
          ...(videoMeta?.width ? { width: videoMeta.width } : {}),
          ...(videoMeta?.height ? { height: videoMeta.height } : {}),
          ...(videoMeta?.durationSeconds ? { durationSeconds: videoMeta.durationSeconds } : {}),
          ...(caption.trim() ? { caption: caption.trim() } : {}),
          previewLabel: mediaPreviewLabel(contentType, file.name)
        },
        {
          xhrRef,
          onProgress: setUploadProgress,
          onPhase: (phase) => setUploadPhase(phase),
          ...(onMediaActivity ? { onActivity: onMediaActivity } : {})
        }
      );
      onMediaSent?.(pending);
      clearAttachment();
      setComposerMode("text");
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setUploadPhase("idle");
        setUploadProgress(0);
        return;
      }
      setUploadPhase("error");
      setUploadError(formatComposerMediaError(error, "attachment"));
    }
  }

  async function submitVoice(recording: VoiceRecordingResult): Promise<void> {
    setVoicePhase("uploading");
    setUploadProgress(0);
    setUploadError(null);
    try {
      const pending = await uploadAndSendComposerMedia(
        chatId,
        recording.blob,
        {
          contentType: "VOICE",
          mimeType: recording.mimeType,
          fileName: recording.fileName,
          forceDocument: false,
          voiceNote: true,
          durationSeconds: recording.durationSeconds,
          waveform: recording.waveform,
          previewLabel: "🎤 Voice Message"
        },
        {
          xhrRef,
          onProgress: setUploadProgress,
          onPhase: (phase) => setVoicePhase(phase === "uploading" ? "uploading" : "sending"),
          ...(onMediaActivity ? { onActivity: onMediaActivity } : {})
        }
      );
      onMediaSent?.(pending);
      URL.revokeObjectURL(recording.objectUrl);
      setVoicePhase("sent");
      resetSpecialModes();
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setVoicePhase("preview");
        return;
      }
      setVoicePhase("failed");
      setUploadError(formatComposerMediaError(error, "voice"));
    }
  }

  async function submitCamera(capture: CameraCaptureResult): Promise<void> {
    setUploadPhase("uploading");
    setUploadProgress(0);
    setUploadError(null);
    try {
      const contentType = capture.kind === "photo" ? "PHOTO" : capture.forceDocument ? "DOCUMENT" : "VIDEO";
      const pending = await uploadAndSendComposerMedia(
        chatId,
        capture.blob,
        {
          contentType,
          mimeType: capture.mimeType,
          fileName: capture.fileName,
          forceDocument: capture.forceDocument,
          ...(capture.width ? { width: capture.width } : {}),
          ...(capture.height ? { height: capture.height } : {}),
          ...(capture.durationSeconds ? { durationSeconds: capture.durationSeconds } : {}),
          ...(capture.caption.trim() ? { caption: capture.caption.trim() } : {}),
          previewLabel: mediaPreviewLabel(contentType, capture.fileName)
        },
        {
          xhrRef,
          onProgress: setUploadProgress,
          onPhase: (phase) => setUploadPhase(phase),
          ...(onMediaActivity ? { onActivity: onMediaActivity } : {})
        }
      );
      onMediaSent?.(pending);
      URL.revokeObjectURL(capture.objectUrl);
      resetSpecialModes();
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setUploadPhase("idle");
        return;
      }
      setUploadPhase("error");
      setUploadError(formatComposerMediaError(error, "camera"));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const el = event.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const { next, caret } = insertTextAtCursor(text, "\n", start, end);
      setText(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = caret;
      });
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  async function submit(): Promise<void> {
    if (selectedFile) {
      await submitMedia(selectedFile);
      return;
    }
    await submitText();
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    void submit();
  }

  function openVoice(): void {
    setEmojiOpen(false);
    setPermissionHint(null);
    if (wasPermissionDeniedThisSession("microphone")) {
      setPermissionHint(classifyMediaError("microphone", Object.assign(new Error("denied"), { name: "NotAllowedError" })).message);
      return;
    }
    clearAttachment();
    setVoicePhase("recording");
    setComposerMode("voice");
  }

  function openCamera(): void {
    setEmojiOpen(false);
    setPermissionHint(null);
    clearAttachment();
    setComposerMode("camera");
  }

  const canSend = selectedFile ? !busy : Boolean(text.trim()) && !busy;
  const effectiveSendAs = canChooseSendAs ? sendAs : isGifFile(selectedFile) ? "photo" : "file";
  const showDefaultComposer = composerMode === "text" || composerMode === "attachment";

  return (
    <form onSubmit={handleSubmit} className="z-10 shrink-0 bg-white px-3 py-2.5">
      {permissionHint ? (
        <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
          {permissionHint}
        </div>
      ) : null}

      {replyTo ? (
        <div className="mb-2 flex items-start gap-2 rounded-md border-l-2 border-[#229ED9] bg-muted/40 px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-[#229ED9]">Reply</p>
            <p className="truncate text-xs text-muted-foreground">{replyTo.preview}</p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Cancel reply"
            onClick={onClearReply}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {composerMode === "voice" ? (
        <div className="mb-2">
          <VoiceRecorderPanel
            disabled={disabled}
            phase={voicePhase}
            uploadProgress={uploadProgress}
            error={uploadError}
            onCancel={resetSpecialModes}
            onSend={submitVoice}
          />
        </div>
      ) : null}

      {composerMode === "camera" ? (
        <div className="mb-2">
          <CameraCapturePanel
            disabled={disabled}
            uploading={uploadPhase === "uploading" || uploadPhase === "sending"}
            uploadProgress={uploadProgress}
            error={uploadError}
            onCancel={resetSpecialModes}
            onFallbackFile={() => {
              resetSpecialModes();
              fileInputRef.current?.click();
            }}
            onSend={submitCamera}
          />
        </div>
      ) : null}

      {selectedFile && showDefaultComposer ? (
        <div className="mb-2 rounded-xl border bg-muted/40 px-3 py-2">
          <div className="flex items-start gap-3">
            {previewUrl && selectedFile.type.startsWith("image/") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="" className="max-h-40 max-w-[10rem] rounded-md object-contain bg-black/5" />
            ) : previewUrl && selectedFile.type.startsWith("video/") ? (
              <video src={previewUrl} className="max-h-40 max-w-[10rem] rounded-md object-contain" muted />
            ) : (
              <div className="flex size-14 items-center justify-center rounded-md bg-white text-lg" aria-hidden="true">
                📎
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{selectedFile.name}</p>
              <p className="text-[11px] text-muted-foreground">{formatFileSize(selectedFile.size)}</p>

              {canChooseSendAs ? (
                <div className="mt-2 flex flex-wrap gap-3 text-xs">
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="send-as"
                      checked={sendAs === "photo"}
                      disabled={busy || selectedFile.size > PHOTO_MAX_BYTES}
                      onChange={() => setSendAs("photo")}
                    />
                    Send as photo
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="send-as"
                      checked={sendAs === "file" || selectedFile.size > PHOTO_MAX_BYTES}
                      disabled={busy}
                      onChange={() => setSendAs("file")}
                    />
                    Send as file
                  </label>
                </div>
              ) : null}
              {selectedFile.size > PHOTO_MAX_BYTES && imageAttachment ? (
                <p className="mt-1 text-[10px] text-amber-700">Large image will be sent as a file.</p>
              ) : null}
              {isGifFile(selectedFile) ? (
                <p className="mt-1 text-[10px] text-muted-foreground">GIF will be sent as an animation when supported.</p>
              ) : null}

              <input
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                placeholder="Add a caption…"
                disabled={busy}
                className="mt-2 w-full rounded-md border bg-white px-2 py-1 text-sm outline-none disabled:opacity-60"
                aria-label="Attachment caption"
              />
              {uploadPhase === "uploading" || uploadPhase === "sending" ? (
                <div className="mt-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
                    <div
                      className="h-full bg-[#229ED9] transition-[width]"
                      style={{ width: `${Math.round((uploadPhase === "sending" ? 1 : uploadProgress) * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {uploadPhase === "sending"
                      ? effectiveSendAs === "photo"
                        ? "Sending photo…"
                        : "Sending file…"
                      : `Uploading ${Math.round(uploadProgress * 100)}%`}
                  </p>
                </div>
              ) : null}
              {uploadError ? (
                <p className="mt-1 text-xs text-red-600" role="alert">
                  {uploadError}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="rounded-full p-1 text-muted-foreground hover:bg-muted"
              aria-label="Remove attachment"
              onClick={clearAttachment}
              disabled={uploadPhase === "sending"}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          {uploadPhase === "error" ? (
            <div className="mt-2 flex gap-2">
              <Button type="button" variant="secondary" className="h-8 px-3 text-xs" onClick={() => void submitMedia(selectedFile)}>
                Retry
              </Button>
              <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={clearAttachment}>
                Cancel
              </Button>
            </div>
          ) : uploadPhase === "uploading" ? (
            <div className="mt-2">
              <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={() => xhrRef.current?.abort()}>
                Cancel upload
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {showDefaultComposer ? (
        <div className="relative flex items-end gap-1.5 rounded-2xl bg-muted/50 px-2 py-1.5">
          <div className="relative">
            <button
              ref={emojiButtonRef}
              type="button"
              className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50"
              aria-label="Emoji"
              title="Emoji"
              aria-expanded={emojiOpen}
              disabled={disabled || Boolean(selectedFile)}
              onClick={() => setEmojiOpen((open) => !open)}
            >
              <Smile className="size-5" aria-hidden="true" />
            </button>
            <EmojiPicker open={emojiOpen} onClose={() => setEmojiOpen(false)} onSelect={insertEmoji} anchorRef={emojiButtonRef} />
          </div>

          <button
            type="button"
            className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50"
            aria-label="Record voice message"
            title="Voice message"
            disabled={disabled || busy || Boolean(selectedFile)}
            onClick={openVoice}
            onPointerDown={(event) => {
              if (event.pointerType === "touch") {
                event.preventDefault();
                openVoice();
              }
            }}
          >
            <Mic className="size-5" aria-hidden="true" />
          </button>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={selectedFile ? "Caption is above · Enter to send" : "Message"}
            disabled={disabled || Boolean(selectedFile)}
            className={cn(
              "max-h-[7.5rem] min-h-[2.5rem] flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-muted-foreground",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
            style={{ lineHeight: `${LINE_HEIGHT_PX}px` }}
            aria-label="Message text"
          />

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,audio/*,*/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setSelectedFile(file);
              setCaption("");
              setSendAs(file && isImageFile(file) && !isGifFile(file) ? "photo" : "file");
              setUploadError(null);
              setUploadPhase("idle");
              setUploadProgress(0);
              setComposerMode(file ? "attachment" : "text");
            }}
          />

          <button
            type="button"
            className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50"
            aria-label="Attach file"
            title="Attach file"
            disabled={disabled || uploadPhase === "uploading" || uploadPhase === "sending"}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-5" aria-hidden="true" />
          </button>

          <button
            type="button"
            className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50"
            aria-label="Camera"
            title="Camera"
            disabled={disabled || busy || Boolean(selectedFile)}
            onClick={openCamera}
          >
            <Camera className="size-5" aria-hidden="true" />
          </button>

          <Button type="submit" className="mb-0.5 size-9 shrink-0 rounded-full p-0" disabled={!canSend} aria-label="Send message">
            <SendHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      {showDefaultComposer ? (
        <p className="mt-1 px-2 text-[10px] text-muted-foreground">Enter to send · Ctrl+Enter for newline</p>
      ) : null}
    </form>
  );
}

function isImageFile(file: File | null): boolean {
  if (!file) return false;
  return file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(file.name);
}

function isGifFile(file: File | null): boolean {
  if (!file) return false;
  return file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
}

function resolveForceDocument(file: File, sendAs: SendAsMode): boolean {
  if (!isImageFile(file)) {
    // Videos from the file picker stay as VIDEO unless the MIME is unknown.
    if (file.type.startsWith("video/")) return false;
    if (file.type.startsWith("audio/")) return false;
    return true;
  }
  if (isGifFile(file)) return false;
  if (file.size > PHOTO_MAX_BYTES) return true;
  return sendAs === "file";
}
