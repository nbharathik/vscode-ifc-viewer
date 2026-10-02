// Runs the extension-host suite against the Insiders build. Equivalent to
// VSCODE_VERSION=insiders, without needing an environment prefix on the
// command line (useful where the stable build is mid-update).
process.env.VSCODE_VERSION ||= 'insiders';
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./runTest');
