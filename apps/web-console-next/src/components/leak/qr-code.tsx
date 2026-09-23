"use client";

import * as React from "react";
import qrcode from "qrcode-generator";

/**
 * A QR code as inline SVG, drawn from the module matrix (no innerHTML).
 * Error-correction level M: a label that is scuffed or partly covered by
 * frost still scans. The quiet zone is the four modules the spec requires.
 */
export function QrCode({ value, size = 160, title }: { value: string; size?: number; title?: string }) {
  const { count, path } = React.useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value, "Byte");
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
      }
    }
    return { count: n + 8, path: d };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={title ?? "QR code"}
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      shapeRendering="crispEdges"
      className="bg-white"
    >
      <rect width={count} height={count} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
