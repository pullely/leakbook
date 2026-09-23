"use client";

/**
 * One-shot "come back here after sign-in" for the QR phone page.
 *
 * A technician who scans a label on a phone that has never signed in is sent
 * to /login; after the code is accepted they must land back on the same
 * label, not on the org picker. The phone page records its own path here
 * before redirecting, and `resolvePostAuthDestination` consumes it once.
 *
 * Only `/q/<token>` paths are accepted, so this can never become an open
 * redirect: anything else stored under the key is ignored and dropped.
 */

import { STORAGE_PREFIX } from "./app-config";

const RETURN_TO_KEY = `${STORAGE_PREFIX}.return-to`;
const QR_PATH_RE = /^\/q\/[a-z2-7]{32}$/;

export function isReturnablePath(path: string): boolean {
  return QR_PATH_RE.test(path);
}

export function rememberReturnTo(path: string): void {
  if (typeof window === "undefined" || !isReturnablePath(path)) return;
  try {
    window.sessionStorage.setItem(RETURN_TO_KEY, path);
  } catch {
    /* ignore */
  }
}

export function takeReturnTo(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const path = window.sessionStorage.getItem(RETURN_TO_KEY);
    window.sessionStorage.removeItem(RETURN_TO_KEY);
    return path && isReturnablePath(path) ? path : null;
  } catch {
    return null;
  }
}
