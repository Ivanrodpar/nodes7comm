module.exports = {
    parser: '@typescript-eslint/parser',
    extends: ['eslint:recommended', 'prettier', 'plugin:prettier/recommended', 'prettier/@typescript-eslint', 'plugin:@typescript-eslint/eslint-recommended', 'plugin:@typescript-eslint/recommended'],
    parserOptions: {
        ecmaVersion: 2018,
        sourceType: 'module',
        ecmaFeatures: {
            jsx: false,
        },
    },
    rules: {
        'prettier/prettier': 'error',
        'no-console': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-inferrable-types': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
    },
    env: {
        es6: true,
        node: true,
    },
};
