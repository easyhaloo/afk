/**
 * The renderer-safe entry.
 *
 * `@afk/workflow-graph/step-graph` is the entry a browser renderer reaches
 * for: the desktop studio's canvas loads it, and a renderer cannot load a
 * node builtin. The claim is proved here on the built artifact — the module
 * graph a renderer would really load — not on the source, and the walk is
 * checked against the main entry, which does reach for a node builtin, so a
 * broken walk cannot pass this file quietly.
 */

import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  exports: Record<string, { types: string; import: string }>;
};

const isNodeBuiltin = (specifier: string): boolean => {
  const name = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return builtinModules.includes(name);
};

/** Every specifier a built module reaches for. */
function importSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const isImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const [argument] = node.arguments;
      if ((isImportCall || isRequireCall) && argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

interface ModuleGraph {
  /** The files the entry loads, entry first. */
  files: string[];
  /** The node builtins it reaches for. */
  nodeBuiltins: string[];
  /** The packages it reaches for. */
  packages: string[];
}

function moduleGraphOf(entry: string): ModuleGraph {
  const files: string[] = [];
  const nodeBuiltins = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.includes(file)) return;
    files.push(file);
    for (const specifier of importSpecifiers(file)) {
      if (isNodeBuiltin(specifier)) {
        nodeBuiltins.add(specifier);
        continue;
      }
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (existsSync(target)) visit(target);
        continue;
      }
      packages.add(specifier);
    }
  };
  visit(entry);
  return { files, nodeBuiltins: [...nodeBuiltins], packages: [...packages] };
}

const entryOf = (subpath: string): string => join(packageRoot, manifest.exports[subpath].import);

describe("the renderer-safe entry", () => {
  it("publishes the step graph on a subpath of its own", () => {
    expect(manifest.exports["./step-graph"]).toEqual({
      types: "./dist/step-graph.d.ts",
      import: "./dist/step-graph.js",
    });
    expect(existsSync(entryOf("./step-graph"))).toBe(true);
  });

  it("loads no node builtin and no package behind the step-graph entry", () => {
    const graph = moduleGraphOf(entryOf("./step-graph"));

    expect(graph.nodeBuiltins).toEqual([]);
    expect(graph.packages).toEqual([]);
    expect(graph.files).toEqual([entryOf("./step-graph")]);
  });

  it("sees the node builtin the main entry reaches for", () => {
    // The control: the walk has to be able to find a builtin, or the check
    // above would pass on a walk that finds nothing at all.
    const graph = moduleGraphOf(entryOf("."));

    expect(graph.nodeBuiltins).toContain("node:crypto");
  });
});
