import { useEffect, type RefObject } from "react";

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
) {
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    if (overlayRef?.current) {
      // Move focus into the overlay so the surface behind (e.g. the xterm
      // terminal) stops receiving keystrokes while the modal is open.
      const focusable = overlayRef.current.querySelector<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      (focusable ?? overlayRef.current).focus();
    }

    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    // Capture phase: the overlay wins over any inner input's Escape handling.
    document.addEventListener("keydown", handler, true);

    return () => {
      document.removeEventListener("keydown", handler, true);
      // Restore focus to whatever had it (e.g. the terminal container) so the
      // user resumes exactly where they were.
      previouslyFocused?.focus?.();
    };
  }, [onClose, overlayRef]);
}
