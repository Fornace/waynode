// Device / input capability helpers. Shared so key-handling logic doesn't
// re-derive "is this a touch device?" inline on every keypress.

/**
 * True on devices with a touch-primary input AND a small viewport — i.e. phones
 * where the soft keyboard has no Shift key and Enter should insert a newline
 * rather than submit. Touch laptops and small desktop windows return false.
 *
 * Computed once and memoised: the capability doesn't change during a session.
 */
export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  const hasTouch = "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
  const smallViewport = window.innerWidth < 1024;
  // Coarse pointer + narrow viewport is the reliable "this is a phone" signal.
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  return hasTouch && smallViewport && coarsePointer;
}
