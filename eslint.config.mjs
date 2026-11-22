import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.venv/**'] },
  {
    files: ['apps/**/*.{ts,tsx,mjs}'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-fallthrough': 'error',
      'no-constant-binary-expression': 'error',
    },
  },
];
