import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default defineConfig(
    {
        ignores: ['lib/', 'node_modules/'],
    },
    {
        files: ['**/*.ts'],
        extends: [js.configs.recommended, tseslint.configs.recommended, prettierRecommended],
        rules: {
            'prettier/prettier': 'error',
            'no-console': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/no-inferrable-types': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
);
