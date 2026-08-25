"use client";

import type { TelegramMessageDto } from "@atlas/shared";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  aspectRatioStyle,
  formatDuration,
  formatFileSize,
  isMediaLoading,
  isMediaUnavailableForDisplay,
  normalizeWaveform,
  readAudioMeta,
  readContactMeta,
  readDiceMeta,
  readLocationCoords,
  readPollMeta
} from "./media-message-helpers";
import { downloadMediaFile, resolveInboxMediaFileName } from "./media-download";
import { RichMessageText } from "./rich-message-text";
import { AuthMediaSrc } from "./auth-media-src";
import { usePlayableMediaUrl } from "./media-url";
import { useAuthStore } from "@/stores/auth-store";
import { canViewDirectCustomerContact, type Role } from "@atlas/shared";

interface MediaMessageBodyProps {
  readonly message: TelegramMessageDto;
}

/**
 * Renders Telegram message body including media, captions, and link previews.
 */
export function MediaMessageBody({ message }: MediaMessageBodyProps) {
  const role = useAuthStore((state) => state.user?.role ?? "STAFF");
  const allowExternalContactLinks = canViewDirectCustomerContact(role as Role);
  const loading = isMediaLoading(message);
  const unavailable = isMediaUnavailableForDisplay(message);
  const isVideoNote = message.contentType === "VIDEO_NOTE" || message.mediaType === "VIDEO_NOTE";
  const mediaKind = isVideoNote ? "VIDEO_NOTE" : message.mediaType;

  return (
    <div className="space-y-1.5">
      {message.replyPreview ? (
        <div className="rounded-md border-l-2 border-[#229ED9] bg-black/5 px-2 py-1 text-xs text-muted-foreground">
          {message.replyPreview}
        </div>
      ) : null}

      {loading ? (
        <MediaLoadingPlaceholder />
      ) : unavailable ? (
        <FallbackLabel>Media unavailable</FallbackLabel>
      ) : (
        <MediaContent message={message} mediaKind={mediaKind} />
      )}

      {message.caption ? (
        <p className="whitespace-pre-wrap break-words leading-relaxed">
          <RichMessageText text={message.caption} allowExternalContactLinks={allowExternalContactLinks} />
        </p>
      ) : null}

      {mediaKind === "TEXT" && message.text ? (
        <p className="whitespace-pre-wrap break-words leading-relaxed">
          <RichMessageText text={message.text} allowExternalContactLinks={allowExternalContactLinks} />
        </p>
      ) : null}

      {message.webPreview?.url ? <WebPreviewCard preview={message.webPreview} /> : null}
    </div>
  );
}

function MediaContent({
  message,
  mediaKind
}: {
  readonly message: TelegramMessageDto;
  readonly mediaKind: TelegramMessageDto["mediaType"] | "VIDEO_NOTE";
}) {
  switch (mediaKind) {
    case "PHOTO":
      return <PhotoBody message={message} />;
    case "VIDEO":
      return <VideoBody message={message} />;
    case "VIDEO_NOTE":
      return <VideoNoteBody message={message} />;
    case "VOICE":
      return <VoiceBody message={message} />;
    case "AUDIO":
      return <AudioBody message={message} />;
    case "DOCUMENT":
      return <DocumentBody message={message} />;
    case "ANIMATION":
      return <AnimationBody message={message} />;
    case "STICKER":
      return <StickerBody message={message} />;
    case "LOCATION":
      return <LocationBody message={message} />;
    case "CONTACT":
      return <ContactBody message={message} />;
    case "POLL":
      return <PollBody message={message} />;
    case "DICE":
      return <DiceBody message={message} />;
    case "TEXT":
    default:
      return null;
  }
}

function MediaLoadingPlaceholder() {
  return (
    <div className="flex h-28 w-48 items-center justify-center rounded-lg bg-black/5 text-xs text-muted-foreground">
      Loading media…
    </div>
  );
}

function PhotoBody({ message }: { readonly message: TelegramMessageDto }) {
  const ratio = aspectRatioStyle(message.width, message.height);
  const downloadSource = message.mediaUrl ?? message.thumbnailUrl;
  return (
    <AuthMediaSrc
      source={downloadSource}
      variant={message.mediaUrl ? "media" : "thumbnail"}
      loadingFallback={<MediaLoadingPlaceholder />}
      errorFallback={<FallbackLabel>📷 Photo unavailable</FallbackLabel>}
    >
      {(src) => <PhotoImage src={src} message={message} {...(ratio ? { ratio } : {})} />}
    </AuthMediaSrc>
  );
}

function PhotoImage({
  src,
  message,
  ratio
}: {
  readonly src: string;
  readonly message: TelegramMessageDto;
  readonly ratio?: string;
}) {
  const [broken, setBroken] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

  if (broken) return <FallbackLabel>📷 Photo unavailable</FallbackLabel>;

  const fileName = resolveInboxMediaFileName({
    fileName: message.fileName,
    contentType: message.contentType,
    mediaType: message.mediaType,
    mimeType: message.mimeType
  });

  return (
    <div className="group relative inline-block max-w-full">
      <button
        type="button"
        className="block max-w-full overflow-hidden rounded-lg text-left"
        onClick={() => window.open(src, "_blank", "noopener,noreferrer")}
        aria-label="Open photo"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={message.caption || "Photo"}
          className="max-h-80 max-w-full object-contain"
          style={ratio ? { aspectRatio: ratio } : undefined}
          onError={() => setBroken(true)}
        />
      </button>
      <button
        type="button"
        className="absolute right-2 top-2 rounded-md bg-black/65 px-2 py-1 text-[11px] font-medium text-white opacity-100 shadow-sm transition hover:bg-black/80 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label="Download photo"
        disabled={downloading}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDownloadError(false);
          setDownloading(true);
          void downloadMediaFile(src, fileName)
            .catch(() => setDownloadError(true))
            .finally(() => setDownloading(false));
        }}
      >
        {downloading ? "Saving…" : "Download"}
      </button>
      {downloadError ? (
        <p className="mt-1 text-[11px] text-red-600">Couldn’t download photo. Try again.</p>
      ) : null}
    </div>
  );
}

function VideoBody({ message }: { readonly message: TelegramMessageDto }) {
  const ratio = aspectRatioStyle(message.width, message.height);
  const poster = usePlayableMediaUrl(message.thumbnailUrl, "thumbnail");
  return (
    <AuthMediaSrc
      source={message.mediaUrl}
      loadingFallback={<MediaLoadingPlaceholder />}
      errorFallback={<FallbackLabel>🎥 Video unavailable</FallbackLabel>}
    >
      {(src) => (
        <video
          src={src}
          controls
          preload="metadata"
          poster={poster.url ?? undefined}
          className="max-h-80 max-w-full rounded-lg bg-black"
          style={ratio ? { aspectRatio: ratio } : undefined}
        />
      )}
    </AuthMediaSrc>
  );
}

function VideoNoteBody({ message }: { readonly message: TelegramMessageDto }) {
  return (
    <AuthMediaSrc
      source={message.mediaUrl}
      loadingFallback={<MediaLoadingPlaceholder />}
      errorFallback={<FallbackLabel>🎥 Video message unavailable</FallbackLabel>}
    >
      {(src) => (
        <video src={src} controls playsInline preload="metadata" className="size-48 rounded-full object-cover bg-black" />
      )}
    </AuthMediaSrc>
  );
}

function VoiceBody({ message }: { readonly message: TelegramMessageDto }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const bars = useMemo(() => normalizeWaveform(message.waveform), [message.waveform]);
  const resolved = usePlayableMediaUrl(message.mediaUrl);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      if (!audio.duration || !Number.isFinite(audio.duration)) return;
      setProgress(audio.currentTime / audio.duration);
    };
    const onEnded = () => {
      setPlaying(false);
      setProgress(0);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnded);
    };
  }, [resolved.url]);

  if (resolved.loading) return <MediaLoadingPlaceholder />;
  if (!resolved.url) return <FallbackLabel>🎤 Voice unavailable</FallbackLabel>;

  return (
    <div className="flex min-w-[14rem] items-center gap-2">
      <button
        type="button"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#229ED9] text-white"
        aria-label={playing ? "Pause voice message" : "Play voice message"}
        onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (audio.paused) {
            void audio.play();
            setPlaying(true);
          } else {
            audio.pause();
            setPlaying(false);
          }
        }}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button
        type="button"
        className="flex h-8 flex-1 items-end gap-0.5"
        aria-label="Seek voice message"
        onClick={(event) => {
          const audio = audioRef.current;
          if (!audio || !audio.duration) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          audio.currentTime = ratio * audio.duration;
          setProgress(ratio);
        }}
      >
        {bars.map((height, index) => (
          <span
            key={index}
            className="w-1 rounded-sm"
            style={{
              height: `${Math.max(12, height * 28)}px`,
              backgroundColor: index / bars.length <= progress ? "#229ED9" : "rgba(0,0,0,0.2)"
            }}
          />
        ))}
      </button>
      <span className="shrink-0 text-[10px] text-muted-foreground">{formatDuration(message.durationSeconds)}</span>
      <audio ref={audioRef} src={resolved.url} preload="metadata" />
    </div>
  );
}

function AudioBody({ message }: { readonly message: TelegramMessageDto }) {
  const meta = readAudioMeta(message.mediaMetadata);
  const title = meta.title || message.fileName || "Audio";
  return (
    <AuthMediaSrc
      source={message.mediaUrl}
      loadingFallback={<MediaLoadingPlaceholder />}
      errorFallback={
        <div>
          <FallbackLabel>🎵 {title}</FallbackLabel>
          {meta.performer ? <p className="text-xs text-muted-foreground">{meta.performer}</p> : null}
        </div>
      }
    >
      {(src) => (
        <div className="min-w-[12rem] space-y-1">
          <p className="text-sm font-medium leading-tight">{title}</p>
          {meta.performer ? <p className="text-xs text-muted-foreground">{meta.performer}</p> : null}
          <audio src={src} controls preload="metadata" className="w-full max-w-xs" />
        </div>
      )}
    </AuthMediaSrc>
  );
}

function DocumentBody({ message }: { readonly message: TelegramMessageDto }) {
  const name = message.fileName || "Document";
  const size = formatFileSize(message.fileSizeBytes);
  return (
    <AuthMediaSrc
      source={message.mediaUrl}
      loadingFallback={<MediaLoadingPlaceholder />}
      errorFallback={<FallbackLabel>📄 {name}</FallbackLabel>}
    >
      {(src) => (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          download={message.fileName ?? undefined}
          className="flex items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-sm hover:bg-black/10"
        >
          <span aria-hidden="true">📄</span>
          <span className="min-w-0">
            <span className="block truncate font-medium">{name}</span>
            {size ? <span className="block text-[10px] text-muted-foreground">{size}</span> : null}
          </span>
        </a>
      )}
    </AuthMediaSrc>
  );
}

function AnimationBody({ message }: { readonly message: TelegramMessageDto }) {
  const mime = message.mimeType?.toLowerCase() ?? "";
  const isVideoAnim =
    mime.includes("video") || mime === "video/mp4" || message.fileName?.toLowerCase().endsWith(".mp4") === true;

  if (message.mediaUrl && isVideoAnim) {
    return (
      <AuthMediaSrc
        source={message.mediaUrl}
        loadingFallback={<MediaLoadingPlaceholder />}
        errorFallback={<FallbackLabel>🎞 GIF unavailable</FallbackLabel>}
      >
        {(src) => (
          <video src={src} autoPlay muted loop playsInline className="max-h-80 max-w-full rounded-lg" />
        )}
      </AuthMediaSrc>
    );
  }

  return (
    <AuthMediaSrc
      source={message.mediaUrl ?? message.thumbnailUrl}
      loadingFallback={<MediaLoadingPlaceholder />}
      errorFallback={<FallbackLabel>🎞 GIF unavailable</FallbackLabel>}
    >
      {(src) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={message.caption || "GIF"} className="max-h-80 max-w-full rounded-lg object-contain" />
      )}
    </AuthMediaSrc>
  );
}

function StickerBody({ message }: { readonly message: TelegramMessageDto }) {
  return (
    <AuthMediaSrc
      source={message.mediaUrl ?? message.thumbnailUrl}
      loadingFallback={<MediaLoadingPlaceholder />}
      errorFallback={<FallbackLabel>🖼 Sticker unavailable</FallbackLabel>}
    >
      {(src) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="Sticker" className="max-h-40 max-w-[10rem] bg-transparent object-contain" />
      )}
    </AuthMediaSrc>
  );
}

function LocationBody({ message }: { readonly message: TelegramMessageDto }) {
  const coords = readLocationCoords(message.mediaMetadata);
  if (!coords) {
    return <FallbackLabel>📍 Location</FallbackLabel>;
  }
  const href = `https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.long}#map=16/${coords.lat}/${coords.long}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-[#229ED9] underline-offset-2 hover:underline"
    >
      <span aria-hidden="true">📍</span>
      {coords.lat.toFixed(5)}, {coords.long.toFixed(5)}
    </a>
  );
}

function ContactBody({ message }: { readonly message: TelegramMessageDto }) {
  const contact = readContactMeta(message.mediaMetadata);
  return (
    <div className="rounded-lg bg-black/5 px-3 py-2">
      <p className="text-sm font-medium">👤 {contact.name}</p>
      {contact.phone ? <p className="text-xs text-muted-foreground">{contact.phone}</p> : null}
    </div>
  );
}

function PollBody({ message }: { readonly message: TelegramMessageDto }) {
  const poll = readPollMeta(message.mediaMetadata);
  return (
    <div className="min-w-[12rem] space-y-1.5">
      <p className="text-sm font-medium">📊 {poll.question}</p>
      <ul className="space-y-1">
        {poll.options.map((option) => (
          <li key={option} className="rounded-md bg-black/5 px-2 py-1 text-xs">
            {option}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DiceBody({ message }: { readonly message: TelegramMessageDto }) {
  return <p className="text-3xl leading-none">{readDiceMeta(message.mediaMetadata)}</p>;
}

function WebPreviewCard({
  preview
}: {
  readonly preview: { readonly url: string; readonly title: string | null; readonly description: string | null };
}) {
  let host = preview.url;
  try {
    host = new URL(preview.url).hostname;
  } catch {
    // Keep raw url host fallback.
  }
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 block overflow-hidden rounded-lg border border-black/10 bg-black/[0.03] px-3 py-2 hover:bg-black/[0.05]"
    >
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{host}</p>
      {preview.title ? <p className="truncate text-sm font-medium">{preview.title}</p> : null}
      {preview.description ? (
        <p className="line-clamp-2 text-xs text-muted-foreground">{preview.description}</p>
      ) : null}
    </a>
  );
}

function FallbackLabel({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
