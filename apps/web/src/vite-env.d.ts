/// <reference types="vite/client" />

/**
 * Declared explicitly rather than relying on Vite's index signature, which is
 * typed `any` — so a typo in a variable name would compile and then be
 * `undefined` at runtime.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
