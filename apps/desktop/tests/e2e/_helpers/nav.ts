import type { Locator, Page } from "playwright";

/**
 * Navigation entries live in two places: the grouped primary nav, and the
 * sidebar's bottom constant area, which carries the global 设置 entry
 * (PRD-2026-10-22-001). One locator for both, so a spec never has to know
 * which side an entry sits on.
 */
export function navButton(page: Page, label: string): Locator {
  return page.locator(".primary-nav button, .sidebar-bottom .nav-item").filter({ hasText: label });
}
