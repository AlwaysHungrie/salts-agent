import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".wrangler/**", "x/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // Keep modules and functions small enough to read in one sitting.
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 100, skipBlankLines: true, skipComments: true }],
    },
  },
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: globals.node } },
  {
    rules: {
      // `const { secret: _secret, ...rest } = row` is how a field is dropped.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],
    },
  }
);
