import { type ReactNode } from "react";
import { createPortal } from "react-dom";

const HOST_ID = "afk-overlay-root";

/**
 * Overlays render into a host that sits outside `.workspace`, the way the
 * prototype keeps its `#overlay` beside `.view` rather than inside it.
 *
 * This is load-bearing, not tidiness. A view's root carries the entry
 * animation, and a non-`none` transform on an ancestor — even the identity
 * `matrix(1, 0, 0, 1, 0, 0)` that Chromium computes from `translateY(0)` —
 * makes that ancestor the containing block for `position: fixed` descendants.
 * An overlay rendered inline then comes back the width of the view box instead
 * of the window: no error, no warning, a drawer at 396px instead of 1440px.
 *
 * Falls back to rendering inline when there is no host. That is the case in the
 * react-test-renderer suites, whose DOM is partial — several have a `document`
 * without `getElementById`, so the guard has to test the method, not the global.
 * fixed-overlay.spec.ts fails if the host goes missing in the real app, so the
 * fallback cannot quietly become the norm.
 */
export function Overlay({ children }: { children: ReactNode }) {
  // `typeof document` is safe on an undeclared global; `document?.x` is not.
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return <>{children}</>;
  const host = document.getElementById(HOST_ID);
  if (!host) return <>{children}</>;
  return createPortal(children, host);
}
