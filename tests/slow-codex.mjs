#!/usr/bin/env node
// Trusted lifecycle-test helper. It intentionally never exits so timeout handling can be verified.
process.stdin.resume();
setInterval(() => {}, 1000);
