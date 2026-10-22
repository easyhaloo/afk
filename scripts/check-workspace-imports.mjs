import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isBuiltin } from 'node:module';

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', 'dist-electron', 'release', 'tests', 'screenshots', 'test-results', 'design-demos'].includes(entry.name)) return [];
    const file = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.[cm]?tsx?$/.test(file) && !/\.(test|spec)\./.test(file) ? [file] : [];
  });
}

export function checkWorkspaceImports(root) {
  const workspaces = ['apps', 'packages'].flatMap(group => {
    const directory = join(root, group);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => existsSync(join(directory, name, 'package.json'))).map(name => ({
      directory: join(directory, name), group, manifest: JSON.parse(readFileSync(join(directory, name, 'package.json'), 'utf8')),
    }));
  });
  const packages = new Map(workspaces.map(workspace => [workspace.manifest.name, workspace]));
  const violations = [];
  for (const workspace of workspaces) {
    const dependencies = { ...workspace.manifest.dependencies, ...workspace.manifest.devDependencies };
    for (const name of Object.keys(dependencies)) {
      if (workspace.group === 'packages' && packages.get(name)?.group === 'apps') violations.push(`${workspace.manifest.name} must not depend on application ${name}`);
    }
    for (const file of sourceFiles(workspace.directory)) {
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const inspect = node => {
        const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
        if (literal && ts.isStringLiteralLike(literal)) {
          const specifier = literal.text;
          if (specifier.startsWith('.')) {
            const target = relative(workspace.directory, resolve(dirname(file), specifier));
            if (target === '..' || target.startsWith('../')) violations.push(`${relative(root, file)} imports outside its workspace: ${specifier}`);
          } else {
            const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
            const target = packages.get(name);
            if (!isBuiltin(specifier) && !dependencies[name]) violations.push(`${relative(root, file)} uses undeclared dependency ${name}`);
            if (target) {
              const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
              if (!target.manifest.exports?.[subpath]) violations.push(`${relative(root, file)} uses private package path ${specifier}`);
              if (relative(workspace.directory, file).startsWith('src/') && workspace.manifest.name === 'afk-control-electron' && name === '@afk/runtime') violations.push(`${relative(root, file)} imports Node runtime into renderer`);
            }
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(ast);
    }
  }
  const visit = (name, parents = []) => {
    if (parents.includes(name)) { violations.push(`workspace dependency cycle: ${[...parents, name].join(' -> ')}`); return; }
    const manifest = packages.get(name)?.manifest;
    for (const dependency of Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies })) if (packages.has(dependency)) visit(dependency, [...parents, name]);
  };
  for (const name of packages.keys()) visit(name);
  return [...new Set(violations)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkWorkspaceImports(resolve(process.argv[2] ?? '.'));
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
  else console.log('Workspace imports passed: applications use declared public package exports; shared packages do not depend on applications.');
}
