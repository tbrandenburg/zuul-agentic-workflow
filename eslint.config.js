import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/fixtures/**",
      "**/generated/**",
      "**/*.d.ts",
      "zuul/**",
      // sandbox/services/example is a standalone target repo the coder
      // agent patches (docs/PLAN.md §3) - it has its own package-local
      // eslint.config.js (plain JS, not TS) and must not be linted by the
      // root TS-aware config.
      "sandbox/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-else-return": "warn",
    },
  },
  eslintConfigPrettier,
);
