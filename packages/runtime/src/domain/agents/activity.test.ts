import { describe, expect, it } from 'vitest';
import { ActivityWatch } from './activity.js';

describe('ActivityWatch', () => {
  it('treats a changed fingerprint as activity', () => {
    let now = 1_000;
    const watch = new ActivityWatch(() => now);

    now = 5_000;
    expect(watch.idleMs()).toBe(4_000);

    watch.observe('pane A');
    expect(watch.idleMs()).toBe(0);

    now = 9_000;
    watch.observe('pane B');
    expect(watch.idleMs()).toBe(0);
  });

  it('keeps counting while the fingerprint stays the same', () => {
    let now = 1_000;
    const watch = new ActivityWatch(() => now);

    watch.observe('pane A');
    now = 4_000;
    watch.observe('pane A');

    expect(watch.idleMs()).toBe(3_000);
  });

  it('measures the silence that follows the last change, not the whole wait', () => {
    let now = 1_000;
    const watch = new ActivityWatch(() => now);

    watch.observe('pane A');
    now = 2_000;
    watch.observe('pane B');
    now = 2_500;

    expect(watch.idleMs()).toBe(500);
  });
});
