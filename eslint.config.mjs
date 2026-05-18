import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const reactHookWarnings = Object.fromEntries(
  Object.keys(reactHooks.configs.recommended.rules).map((ruleName) => [ruleName, "warn"])
);

const tsFiles = [
  "apps/**/*.{ts,tsx}",
  "packages/**/*.{ts,tsx}",
  "shared/**/*.ts",
  "scripts/**/*.ts",
  "test/**/*.ts",
];
const jsFiles = [
  "*.config.{js,cjs,mjs}",
  "apps/**/*.{js,cjs,mjs}",
  "packages/**/*.{js,cjs,mjs}",
  "scripts/**/*.{js,cjs,mjs}",
  "test/**/*.{js,cjs,mjs}",
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/node_modules/**",
      "dist-electron/**",
      "apps/agent-server/dist/**",
      "apps/web/src/features/browser/automation/dist-inject/**",
      "packages/device-use/bin/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: tsFiles,
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "no-empty": "warn",
      "no-useless-escape": "warn",
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}", "apps/landing/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHookWarnings,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    files: ["apps/cloud-relay/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.worker,
      },
    },
  },
  {
    files: [
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "test/**/*.{ts,tsx}",
      "apps/**/test/**/*.{ts,tsx}",
      "packages/**/test/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  {
    extends: [js.configs.recommended],
    files: jsFiles,
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": "warn",
      "no-useless-escape": "warn",
    },
  },
  {
    files: ["apps/web/**/*.{js,mjs}", "apps/landing/**/*.{js,mjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
  }
);
