module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        // Override tsconfig for tests — allow test globals
        strict: false,
        noImplicitAny: false,
        esModuleInterop: true,
        module: 'commonjs',
        target: 'ES2022',
        lib: ['ES2022'],
        moduleResolution: 'node'
      }
    }]
  },
  moduleFileExtensions: ['ts', 'js', 'json']
};
