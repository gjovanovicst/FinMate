import type { Config } from 'jest';

/**
 * Jest for apps/api (docs/10 §2). The library packages use Vitest; the API uses Jest because it
 * is the NestJS-native runner and its `TestingModule` utilities are first-class here.
 *
 * `moduleNameMapper` mirrors the `paths` in tsconfig.base.json so tests resolve workspace
 * packages the same way `tsx` does at runtime. If a new package is added, add it here too.
 */
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleNameMapper: {
    '^@finmate/domain$': '<rootDir>/../../packages/domain/src/index.ts',
    '^@finmate/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^@finmate/nlp$': '<rootDir>/../../packages/nlp/src/index.ts',
    '^@finmate/rules-engine$': '<rootDir>/../../packages/rules-engine/src/index.ts',
    '^@finmate/ai$': '<rootDir>/../../packages/ai/src/index.ts',
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**', '!src/main.ts'],
  // Generated Prisma client is large; keep it out of the transform cost.
  transformIgnorePatterns: ['/node_modules/', '/src/generated/'],
};

export default config;
