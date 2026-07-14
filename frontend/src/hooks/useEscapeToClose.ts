import { useEffect, useRef, type RefObject } from "react";

const overlayStack: symbol[] = [];
const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * Close the topmost overlay when Escape is pressed, and trap focus inside it
 * while open so the terminal / chat behind it don't receive input.
 *
 * Per docs/KEYBOARD-CONTRACT.md §1.3 Layer 1: when a modal is open it owns
 * Escape unconditionally. Focus is moved into the overlay on mount and restored
 * to the previously-focused element on unmount, so a focused xterm terminal
 * naturally stops receiving `onData` while the modal is up.
 *
 * @param onClose  called on Escape (and only on Escape — overlay click is the
 *                 component's own concern).
 * @param overlayRef optional ref to the overlay root; if provided, focus is
 *                   moved into it on mount for the focus-trap behaviour.
 */
export function useEscapeToClose(
  onClose: () => void,
  overlayRef?: RefObject<HTMLElement | null>,
  enabled = true,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const token = Symbol("overlay");
    overlayStack.push(token);

    if (overlayRef?.current) {
      // Move focus into the overlay so the surface behind (e.g. the xterm
      // terminal) stops receiving keystrokes while the modal is open.
      const focusable = overlayRef.current.querySelector<HTMLElement>(FOCUSABLE);
      (focusable ?? overlayRef.current).focus();
    }

    const handler = (event: KeyboardEvent) => {
      if (overlayStack.at(-1) !== token) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab" && overlayRef?.current) {
        const focusable = [...overlayRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
          .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
        if (focusable.length === 0) {
          event.preventDefault();
          overlayRef.current.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    // Capture phase: the overlay wins over any inner input's Escape handling.
    document.addEventListener("keydown", handler, true);

    return () => {
      document.removeEventListener("keydown", handler, true);
      const index = overlayStack.lastIndexOf(token);
      if (index >= 0) overlayStack.splice(index, 1);
      // Restore focus to whatever had it (e.g. the terminal container) so the
      // user resumes exactly where they were.
      previouslyFocused?.focus?.();
    };
  }, [enabled, overlayRef]);
}
