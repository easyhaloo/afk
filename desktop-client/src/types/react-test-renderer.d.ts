/**
 * The renderer tests drive hooks through react-test-renderer. The package
 * ships no type declarations, so this file describes the part of its
 * interface the renderer uses. It is a declaration only: no runtime, no
 * dependency.
 */
declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export type ReactTestRendererJSON = {
    type: string;
    props: Record<string, any>;
    children: Array<ReactTestRendererNode> | null;
  };

  export type ReactTestRendererNode = ReactTestRendererJSON | string;

  export type ReactTestInstance = {
    children: unknown[];
    props: Record<string, any>;
    find(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance;
    findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[];
    findByType(type: unknown): ReactTestInstance;
    findAllByType(type: unknown): ReactTestInstance[];
    findByProps(props: Record<string, unknown>): ReactTestInstance;
    findAllByProps(props: Record<string, unknown>): ReactTestInstance[];
  };

  export type TestRenderer = {
    root: ReactTestInstance;
    update(element: ReactElement): void;
    unmount(): void;
    toJSON(): ReactTestRendererJSON | ReactTestRendererJSON[] | null;
  };

  /** The name the package itself exports for the renderer. */
  export type ReactTestRenderer = TestRenderer;

  export type TestRendererOptions = {
    createNodeMock?: (element: ReactTestInstance) => unknown;
  };

  export function create(element: ReactElement, options?: TestRendererOptions): TestRenderer;
  export function act(callback: () => void | Promise<void>): Promise<void>;
}
