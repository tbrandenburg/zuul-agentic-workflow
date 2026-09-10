import js from "@eslint/js";

// Minimal package-local flat config (docs/PLAN.md §11 Phase 4 task 4.1) -
// this repo is plain ESM JavaScript, not TypeScript, so it does not reuse
// the root tseslint config; it reuses only the shared `@eslint/js`
// recommended rule set already installed at the workspace root.
export default [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { console: "readonly", process: "readonly" },
    },
  },
];
