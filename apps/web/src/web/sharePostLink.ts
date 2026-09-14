"use client";

import { postShareText, postShareUrl } from "soso-core";

/**
 * Handing a pin to another app.
 *
 * Structurally the same as `saveMessageImage` in MessageImageView.tsx —
 * try the native share sheet, fall back to something every browser can do —
 * and deliberately NOT merged with it. That one shares a `File` it has to
 * fetch first and falls back to a download; this shares a URL it computes
 * synchronously and falls back to the clipboard. They have the share sheet
 * in common and nothing else.
 *
 * WHAT ACTUALLY TRAVELS
 * ---------------------------------------------------------------------
 * A link and a category name. Never the body, never the address, never the
 * author — see `postShareText` in soso-core for why: this text lands in an
 * SMS, a tweet, a pasted note, none of which have any audience check at
 * all. Whoever follows the link gets exactly what the server decides they
 * may see, which for a private pin is nothing.
 *
 * `navigator.share` is available on essentially every mobile browser and
 * almost no desktop one, which is the right split: a phone has a share
 * sheet full of the apps people actually want to send this to, and a
 * desktop browser's answer to "share this" has always been a copied link.
 */

export type ShareLinkOutcome = "shared" | "copied" | "cancelled";

export class ShareLinkError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ShareLinkError";
  }
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Safari before 13.1 and any page served over plain HTTP have no
  // clipboard API at all. `execCommand` is deprecated and still the only
  // thing that works there, so it stays as the last resort rather than the
  // feature silently doing nothing.
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    if (!document.execCommand("copy")) throw new ShareLinkError("copy refused");
  } finally {
    document.body.removeChild(area);
  }
}

export async function sharePostLink(
  postId: string,
  categoryLabel: string,
): Promise<ShareLinkOutcome> {
  // Built from the CURRENT page, so the link points at whatever origin and
  // base path this app is actually deployed under — see postShareUrl.
  const url = postShareUrl(window.location.href, postId);
  const text = postShareText(categoryLabel);

  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "SoSo", text, url });
      return "shared";
    } catch (err) {
      const name = (err as DOMException | undefined)?.name;
      // Dismissed the sheet. Not a failure, and reporting one would be
      // wrong — the same distinction saveMessageImage draws.
      if (name === "AbortError") return "cancelled";
      // Anything else (NotAllowedError from a lost gesture window, a
      // platform with the method but no handler) still has a good answer:
      // put the link on the clipboard rather than reporting a dead button.
    }
  }

  await copyToClipboard(url);
  return "copied";
}
