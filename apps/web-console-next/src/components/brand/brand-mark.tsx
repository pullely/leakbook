import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * The Leakbook mark: a droplet with a small snowflake cut-out.
 *
 * Drawn on a 24×24 grid in `currentColor`, so it takes the colour of the
 * badge it sits in (`text-primary-foreground` on `bg-primary`).
 * `src/app/icon.svg` is the same mark with fixed colours, because a favicon
 * can't read CSS variables.
 */
export function BrandMark({ className }: { className?: string }) {
  // One mask per rendered mark, so two marks on a page never share an id.
  const maskId = `brand-mark-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-5 w-5", className)}
      aria-hidden="true"
      focusable="false"
    >
      <mask id={maskId}>
        <rect width="24" height="24" fill="#fff" />
        <path d="M12 11.5v7M9 13.25l6 3.5M9 16.75l6-3.5" stroke="#000" strokeWidth="1.5" strokeLinecap="round" />
      </mask>
      <path d="M12 2.5S5 10.2 5 14.5a7 7 0 0 0 14 0C19 10.2 12 2.5 12 2.5z" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}
