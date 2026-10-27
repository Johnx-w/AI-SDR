import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const compiledModules = new Map();

function compile(path) {
  if (!compiledModules.has(path.href)) {
    const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
      fileName: fileURLToPath(path),
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    compiledModules.set(path.href, new Function('require', 'module', 'exports', compiled));
  }
  return compiledModules.get(path.href);
}

// Each loader owns its evaluated modules so test-specific imports stay isolated.
export function createModuleLoader(resolveImport = () => undefined) {
  const cache = new Map();
  function load(path) {
    if (cache.has(path.href)) return cache.get(path.href).exports;
    const module = { exports: {} };
    cache.set(path.href, module);
    const normalRequire = createRequire(path);
    const require = (specifier) => {
      const replacement = resolveImport(specifier, path);
      if (replacement !== undefined) return replacement;
      if (specifier.endsWith('.css')) return {};
      if (specifier.startsWith('.')) {
        for (const extension of ['', '.tsx', '.ts']) {
          const child = new URL(specifier + extension, path);
          if (existsSync(child) && /\.tsx?$/.test(child.pathname)) return load(child);
        }
      }
      return normalRequire(specifier);
    };
    compile(path)(require, module, module.exports);
    return module.exports;
  }
  return load;
}

export const loadModule = createModuleLoader();
