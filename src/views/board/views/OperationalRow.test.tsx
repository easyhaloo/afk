import React from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { OperationalRow } from './OperationalRow';

const baseProps = {
  status: 'ready',
  statusColor: 'green',
  mode: 'afk',
  id: '42',
  title: 'Repair dashboard layout',
  summary: 'parent 10 · depends 7',
};

describe('OperationalRow', () => {
  it('renders only colored status/mode icons and title at compact widths', () => {
    const output = renderToString(
      <OperationalRow {...baseProps} width={79} selected title="修复中文显示宽度" />,
    );

    expect(output).toContain('○');
    expect(output).toContain('⚙');
    expect(output).not.toContain('ready');
    expect(output).not.toContain('afk');
    expect(output).toContain('修复中文显示宽度');
    expect(output).not.toContain('depends 7');
  });

  it('truncates CJK titles by visual width', () => {
    const output = renderToString(
        <OperationalRow {...baseProps} width={32} selected title="修复中文显示宽度问题以及更多内容" />,
    );

    expect(output).toContain('修复中文显示宽度问题…');
    expect(output).not.toContain('修复中文显示宽度问题以及更多内容');
  });

  it('uses a fixed-width selected marker', () => {
    const selected = renderToString(<OperationalRow {...baseProps} width={79} selected />);
    const unselected = renderToString(<OperationalRow {...baseProps} width={79} selected={false} />);

    expect(selected).toContain('▶ ');
    expect(unselected).toContain('  ');
    expect(selected.indexOf('○')).toBe(2);
    expect(unselected.indexOf('○')).toBe(2);
  });

  it('allocates the same title width for selected and unselected symbols', () => {
    const selected = renderToString(
      <OperationalRow {...baseProps} width={32} selected title="修复中文显示宽度问题以及更多内容" />,
    );
    const unselected = renderToString(
      <OperationalRow {...baseProps} width={32} selected={false} title="修复中文显示宽度问题以及更多内容" />,
    );

    expect(selected.replace('▶ ', '  ')).toBe(unselected);
  });

  it('renders a truncated summary at wide widths', () => {
    const output = renderToString(
      <OperationalRow
        {...baseProps}
        width={80}
        selected={false}
        summary="parent 10 · depends 7 · labels team:platform"
      />,
    );

    expect(output).toContain(' · parent 10 · depen…');
    expect(output).not.toContain('labels team:platform');
  });

  it('preserves the title before allocating tail metadata', () => {
    const output = renderToString(
      <OperationalRow
        {...baseProps}
        width={120}
        selected={false}
        title="Keep the primary backlog title readable"
        summary="parent 10 · depends 7 · labels team:platform"
      />,
    );

    expect(output).toContain('Keep the primary backlog title readable');
  });

  it('keeps a narrow row on one line', () => {
    const output = renderToString(
      <OperationalRow
        {...baseProps}
        width={8}
        selected
        status="running"
        mode="batch"
        title="a very long title"
        summary="a very long summary"
      />,
    );

    expect(output.replace(/\n+$/, '')).not.toContain('\n');
  });

  it('does not emit an ellipsis when title allocation is zero', () => {
    const output = renderToString(
      <OperationalRow
        {...baseProps}
        width={7}
        selected
        status="r"
        mode="m"
        id="1"
        title="title"
      />,
    );

    expect(output).not.toContain('…');
    expect(output).not.toContain('title');
  });
});
