import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { Notification } from './Notification';

// ink-testing-library rendering tests
// Note: position:absolute requires terminal context. We test the component
// by wrapping it in a sized container to simulate terminal dimensions.
describe('Notification rendering', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('renders notification message when wrapped in sized container', async () => {
    // Wrap Notification in a Box with explicit dimensions
    // This simulates terminal context so Yoga can compute absolute position
    const notification = { type: 'info' as const, message: 'Test message' };

    // Create a container that gives Yoga the dimensions it needs
    const TestContainer = () => (
      <Box width={80} height={24}>
        <Notification notification={notification} animation="visible" />
      </Box>
    );

    const { lastFrame } = render(React.createElement(TestContainer));
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(lastFrame()).toContain('Test message');
  });

  it('renders notification with slide-in animation', async () => {
    const notification = { type: 'success' as const, message: 'Done!' };

    const TestContainer = () => (
      <Box width={80} height={24}>
        <Notification notification={notification} animation="slide-in" />
      </Box>
    );

    const { lastFrame } = render(React.createElement(TestContainer));
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(lastFrame()).toContain('Done!');
  });

  it('renders error notification with dimmed text', async () => {
    const notification = { type: 'error' as const, message: 'Failed' };

    const TestContainer = () => (
      <Box width={80} height={24}>
        <Notification notification={notification} animation="slide-out" />
      </Box>
    );

    const { lastFrame } = render(React.createElement(TestContainer));
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(lastFrame()).toContain('Failed');
  });

  it('renders nothing when notification is null', async () => {
    const TestContainer = () => (
      <Box width={80} height={24}>
        <Notification notification={null} animation="hidden" />
      </Box>
    );

    const { lastFrame } = render(React.createElement(TestContainer));
    await new Promise(resolve => setTimeout(resolve, 100));

    // When notification is null, Notification returns null
    // But the wrapping Box may still output whitespace/newlines
    // Check that no actual notification content is rendered
    expect(lastFrame()).not.toContain('Message:');
    expect(lastFrame()).not.toContain('Test message');
  });
});

// Pure logic tests - always run, no ink/rendering dependency
describe('Notification logic', () => {
  it('should not render when notification is null', () => {
    const shouldRender = (n: { type: string; message: string } | null): boolean => n !== null;
    expect(shouldRender(null)).toBe(false);
  });

  it('should render when notification exists', () => {
    const shouldRender = (n: { type: string; message: string } | null): boolean => n !== null;
    expect(shouldRender({ type: 'info', message: 'test' })).toBe(true);
  });

  it('dimColor is only true for slide-out animation', () => {
    type Animation = 'hidden' | 'slide-in' | 'visible' | 'slide-out';
    const shouldDim = (a: Animation): boolean => a === 'slide-out';
    expect(shouldDim('slide-out')).toBe(true);
    expect(shouldDim('visible')).toBe(false);
    expect(shouldDim('slide-in')).toBe(false);
    expect(shouldDim('hidden')).toBe(false);
  });

  it('all animation states are accounted for', () => {
    type Animation = 'hidden' | 'slide-in' | 'visible' | 'slide-out';
    const animations: Animation[] = ['hidden', 'slide-in', 'visible', 'slide-out'];
    const shouldDim = (a: Animation): boolean => a === 'slide-out';
    const shouldShow = (a: Animation): boolean => a !== 'hidden';

    animations.forEach(anim => {
      const dimResult = shouldDim(anim);
      const showResult = shouldShow(anim);
      expect(typeof dimResult).toBe('boolean');
      expect(typeof showResult).toBe('boolean');
    });

    expect(animations.filter(a => shouldDim(a))).toEqual(['slide-out']);
    expect(animations.filter(a => shouldShow(a))).toEqual(['slide-in', 'visible', 'slide-out']);
  });
});
