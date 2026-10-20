/**
 * The elements a modal may move focus to.
 *
 * A dialog that lets the focus leave it is not a dialog any more, and the
 * rule of what may hold the focus is the same in every one of them.  Three
 * pages each carried the selector and the list that came out of it.
 */
const modalFocusableSelector = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(modalFocusableSelector)).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}
