import type { ReactNode } from "react";
import { createElement, Fragment } from "react";

interface Token {
  readonly type: "text" | "link";
  readonly value: string;
  readonly href?: string;
}

export interface RichTextOptions {
  /** When false, phone / @username / t.me / wa.me / mailto stay plain text. */
  readonly allowExternalContactLinks?: boolean;
}

/**
 * Splits message text into plain segments and clickable link segments.
 * Detects URLs, t.me / wa.me, emails, @usernames, #hashtags, and phone numbers.
 */
export function tokenizeRichText(input: string, options: RichTextOptions = {}): Token[] {
  if (!input) return [];
  const allowExternal = options.allowExternalContactLinks !== false;
  const pattern =
    /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|t\.me\/[^\s<>"']+|telegram\.me\/[^\s<>"']+|wa\.me\/[^\s<>"']+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|@[a-zA-Z][a-zA-Z0-9_]{3,31}|#[\p{L}\p{N}_]{2,64}|\+?\d[\d\s().-]{6,}\d)/gu;

  const tokens: Token[] = [];
  let lastIndex = 0;
  for (const match of input.matchAll(pattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ type: "text", value: input.slice(lastIndex, index) });
    }
    if ((value.startsWith("@") || value.startsWith("#")) && index > 0) {
      const prev = input[index - 1] ?? "";
      if (/[a-zA-Z0-9_]/.test(prev)) {
        continue;
      }
    }
    if (!allowExternal && isExternalContactMatch(value)) {
      tokens.push({ type: "text", value });
    } else {
      tokens.push({ type: "link", value, href: hrefForMatch(value) });
    }
    lastIndex = index + value.length;
  }
  if (lastIndex < input.length) {
    tokens.push({ type: "text", value: input.slice(lastIndex) });
  }
  return tokens.length > 0 ? tokens : [{ type: "text", value: input }];
}

/**
 * Renders message/caption text with clickable rich links.
 */
export function RichMessageText({
  text,
  className,
  allowExternalContactLinks = true
}: {
  readonly text: string;
  readonly className?: string;
  readonly allowExternalContactLinks?: boolean;
}): ReactNode {
  const tokens = tokenizeRichText(text, { allowExternalContactLinks });
  return createElement(
    "span",
    { className },
    ...tokens.map((token, index) => {
      if (token.type === "text") {
        return createElement(Fragment, { key: index }, token.value);
      }
      return createElement(
        "a",
        {
          key: index,
          href: token.href,
          target: "_blank",
          rel: "noopener noreferrer",
          className: "font-medium text-[#0b63ce] underline-offset-2 hover:underline"
        },
        token.value
      );
    })
  );
}

function isExternalContactMatch(value: string): boolean {
  if (value.startsWith("@")) return true;
  if (value.includes("@") && !value.includes("://")) return true;
  if (/^(?:\+?\d[\d\s().-]{6,}\d)$/.test(value)) return true;
  if (/^(?:https?:\/\/)?(?:t\.me|telegram\.me|wa\.me|api\.whatsapp\.com)\b/i.test(value)) return true;
  if (/^tel:/i.test(value)) return true;
  return false;
}

function hrefForMatch(value: string): string {
  if (value.startsWith("@")) {
    return `https://t.me/${value.slice(1)}`;
  }
  if (value.startsWith("#")) {
    return `https://t.me/s/${encodeURIComponent(value.slice(1))}`;
  }
  if (value.includes("@") && !value.includes("://") && !value.startsWith("t.me") && !value.startsWith("wa.me")) {
    return `mailto:${value}`;
  }
  if (/^(?:\+?\d[\d\s().-]{6,}\d)$/.test(value)) {
    return `tel:${value.replace(/[^\d+]/g, "")}`;
  }
  if (value.startsWith("t.me/") || value.startsWith("telegram.me/") || value.startsWith("wa.me/")) {
    return `https://${value}`;
  }
  if (value.startsWith("www.")) {
    return `https://${value}`;
  }
  return value;
}
