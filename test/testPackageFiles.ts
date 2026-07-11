import { tests } from '@iobroker/testing';

// Validate the package files (package.json and io-package.json) using @iobroker/testing.
// mocha is always launched from the repo root (npm "test:package" script), so cwd is the package root.
// Deliberately avoid __dirname / import.meta so this file loads under both CommonJS and ESM — recent
// Node versions strip TS types and detect the `import` syntax as ESM, where __dirname is undefined.
tests.packageFiles(process.cwd());
