import React from 'react';
import { PassThrough } from 'node:stream';
import { render, renderToString } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { AppContent } from './AppContent.js';
import { StateProvider } from './state/StateContext.js';
import type { Task } from '../../types/board.js';
import { inMemoryRuntimePorts } from '../../../tests/support/runtime-ports.js';

const originalColumns = process.stdout.columns;
const originalRows = process.stdout.rows;

function task(index: number): Task {
  return {
    backlogId: String(index),
    runId: `run-${index}`,
    title: `Long-running task ${index}`,
    phase: 'implementing',
    executionMode: 'batch',
    sandboxProvider: 'local',
    agentProvider: 'claude-code',
    status: 'active',
  };
}

/** A terminal the test drives, standing in for the user's. */
function fakeTerminal() {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.defineProperty(stdin, 'isTTY', { value: true });
  Object.assign(stdin, { setRawMode: () => {}, ref: () => {}, unref: () => {} });

  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.defineProperty(stdout, 'columns', { value: 100 });
  Object.defineProperty(stdout, 'rows', { value: 16 });
  let frame = '';
  stdout.on('data', chunk => { frame += chunk.toString(); });

  const committed: Array<() => void> = [];
  return {
    stdin,
    stdout,
    frame: () => frame,
    /** Ink calls this once per committed frame. */
    onRender: () => { committed.shift()?.(); },
    /** Resolves when the next frame is committed, or shortly after. */
    nextFrame: () => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 250);
      committed.push(() => { clearTimeout(timer); resolve(); });
    }),
  };
}

/**
 * Wait for the board to show something.
 *
 * The wait is a promise the renderer resolves rather than a timer that
 * polls: a timer that polls the output starves the renderer, because Ink
 * schedules its frames on the same task queue and a timer that never lets
 * go keeps the board from ever painting.
 */
async function waitForFrame(
  terminal: { frame: () => string; nextFrame: () => Promise<void> },
  predicate: (frame: string) => boolean,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate(terminal.frame())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the board');
    await terminal.nextFrame();
    // The frame reaches the stream on the next tick, after the render
    // that produced it has already been committed.
    await new Promise(resolve => setImmediate(resolve));
  }
}

afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: originalColumns });
  Object.defineProperty(process.stdout, 'rows', { configurable: true, value: originalRows });
});

describe('AppContent', () => {
  it('uses the task list as the default task body', () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 16 });

    const output = renderToString(
      <StateProvider>
        <AppContent
          ports={inMemoryRuntimePorts()}
          tasks={[task(1)]}
          backlogs={[]}
          projects={[]}
          projectBranches={[]}
          projectTags={[]}
          projectCommits={[]}
          projectHasMore={false}
          onLoadProjectDetail={() => {}}
          onReloadTasks={() => {}}
          onReloadBacklogs={() => {}}
          onFetchMoreProjects={() => {}}
          onInvalidateDetailCache={() => {}}
        />
      </StateProvider>,
    );

    expect(output).toContain('[active] (batch) #1 Long-running task 1');
    expect(output).not.toContain('recent activity');
  });

  it('keeps static list commands in the footer instead of repeating them above the content', () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 12 });

    const output = renderToString(
      <StateProvider>
        <AppContent
          ports={inMemoryRuntimePorts()}
          tasks={[task(1)]}
          backlogs={[]}
          projects={[]}
          projectBranches={[]}
          projectTags={[]}
          projectCommits={[]}
          projectHasMore={false}
          onLoadProjectDetail={() => {}}
          onReloadTasks={() => {}}
          onReloadBacklogs={() => {}}
          onFetchMoreProjects={() => {}}
          onInvalidateDetailCache={() => {}}
        />
      </StateProvider>,
    );

    expect(output.match(/enter detail/g)).toHaveLength(1);
  });

  it('keeps the header and footer visible when the task list exceeds the viewport', () => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 100 });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 12 });

    const output = renderToString(
      <StateProvider>
        <AppContent
          ports={inMemoryRuntimePorts()}
          tasks={Array.from({ length: 30 }, (_, index) => task(index + 1))}
          backlogs={[]}
          projects={[]}
          projectBranches={[]}
          projectTags={[]}
          projectCommits={[]}
          projectHasMore={false}
          onLoadProjectDetail={() => {}}
          onReloadTasks={() => {}}
          onReloadBacklogs={() => {}}
          onFetchMoreProjects={() => {}}
          onInvalidateDetailCache={() => {}}
        />
      </StateProvider>,
    ).trimEnd().split('\n');

    expect(output[0]).toContain('AFK Dashboard');
    expect(output.at(-1)).toContain('move');
    expect(output).not.toContain(expect.stringContaining('Long-running task 30'));
  });

  it('opens a project link through the browser capability it was given', async () => {
    const opened: string[] = [];
    let openedResolve: () => void = () => {};
    const openedPromise = new Promise<void>(resolve => { openedResolve = resolve; });
    const ports = inMemoryRuntimePorts();
    ports.browser.open = async (url: string) => {
      opened.push(url);
      openedResolve();
    };

    const terminal = fakeTerminal();
    const app = render(
      <StateProvider>
        <AppContent
          ports={ports}
          tasks={[]}
          backlogs={[]}
          projects={[{
            id: 9,
            name: 'AFK fixture',
            path_with_namespace: 'afk/fixture',
            description: 'Fixture project',
            default_branch: 'main',
            namespace: { name: 'afk' },
            web_url: 'https://example.test/projects/9',
          }]}
          projectBranches={[]}
          projectTags={[]}
          projectCommits={[]}
          projectHasMore={false}
          onLoadProjectDetail={() => {}}
          onReloadTasks={() => {}}
          onReloadBacklogs={() => {}}
          onFetchMoreProjects={() => {}}
          onInvalidateDetailCache={() => {}}
        />
      </StateProvider>,
      {
        stdin: terminal.stdin,
        stdout: terminal.stdout,
        patchConsole: false,
        // Ink only paints a frame on a terminal it drives; the debug mode
        // writes the whole frame out, which is what the test reads.
        debug: true,
        onRender: terminal.onRender,
      },
    );

    try {
      await waitForFrame(terminal, frame => frame.includes('AFK Dashboard'));
      terminal.stdin.write('3');
      await waitForFrame(terminal, frame => frame.includes('AFK fixture'));
      terminal.stdin.write('o');
      await openedPromise;
    } finally {
      app.unmount();
    }

    expect(opened).toEqual(['https://example.test/projects/9']);
  });
});
