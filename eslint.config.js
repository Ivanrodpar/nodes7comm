import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
    js.configs.recommended,
    ...tseslint.configs.recommended,
    eslintPluginPrettierRecommended,
    {
        ignores: ['lib'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        plugins: {
            prettier,
        },
        rules: {
            'no-console': 'off',
            'no-unused-vars': 'off',
            'prettier/prettier': 'error',
            'preserve-caught-error': 'off',
        },
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        plugins: {
            prettier,
        },
        rules: {
            'no-console': 'off',
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-inferrable-types': 'off',
            'prettier/prettier': 'error',
            'preserve-caught-error': 'off',
            'no-useless-assignment': 'warn',
        },
    },
];
