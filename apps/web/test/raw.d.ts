/**
 * Ambient declarations for Vite's raw imports, used by specs that must assert a **file's own bytes**.
 *
 * `styles.tokens.spec.ts` measures the contrast of the design tokens as they are written in
 * `styles.css`, and `ngsw-config.spec.ts` asserts the service-worker configuration. Neither can read a
 * file with `node:fs`: specs are compiled by `web:typecheck`, and that project is a browser program with
 * `"types": []` — the toolchain deliberately has no Node types in it. A raw import is resolved by Vite at
 * test time and by nothing at build time, which is exactly the shape needed.
 */
declare module '*.css?raw' {
  const content: string;
  export default content;
}

declare module '*.json?raw' {
  const content: string;
  export default content;
}

/**
 * `import.meta.glob`, which `template-literal.spec.ts` uses to read every source file as text.
 *
 * Vite's own client types are not in this project (`"types": []` on purpose — a browser program has no
 * Node types and needs no bundler types at build time), so the one Vite API a spec uses is declared here
 * rather than pulling the whole `vite/client` surface into the app's type space.
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string | readonly string[],
    options?: {
      readonly query?: string;
      readonly import?: string;
      readonly eager?: boolean;
      readonly as?: string;
    },
  ): Record<string, T>;
}
