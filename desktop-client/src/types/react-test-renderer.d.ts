/**
 * The renderer tests drive hooks through react-test-renderer. The package
 * ships no type declarations, so this file describes the part of its
 * interface the renderer uses. It is a declaration only: no runtime, no
 * dependency.
 */
declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export type ReactTestInstance = {
    children: unknown[];
    props: Record<string, any>;
    findByType(type: unknown): ReactTestInstance;
    findAllByType(type: unknown): ReactTestInstance[];
    findByProps(props: Record<string, unknown>): ReactTestInstance;
    findAllByProps(props: Record<string, unknown>): ReactTestInstance[];
  };

  export type TestRenderer = {
    root: ReactTestInstance;
    update(element: ReactElement): void;
    unmount(): void;
  };

  export function create(element: ReactElement): TestRenderer;
  export function act(callback: () => void | Promise<void>): Promise<void>;
}
