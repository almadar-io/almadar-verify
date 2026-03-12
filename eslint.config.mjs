import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const almadarPlugin = require("@almadar/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");

export default [
  {
    ignores: ["node_modules/**", "dist/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      almadar: almadarPlugin,
    },
    rules: {
      "almadar/no-as-any": "error",
    },
  },
];
