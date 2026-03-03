// Patches rpc-websockets v7.11+ for compatibility with @solana/web3.js v1.
// web3.js v1 imports 'rpc-websockets/dist/lib/client' and
// 'rpc-websockets/dist/lib/client/websocket' which were renamed to .cjs
// in newer versions. This adds shim files so require() resolves correctly.

const fs = require("fs");
const path = require("path");

const clientDir = path.join(
  __dirname,
  "..",
  "node_modules",
  "rpc-websockets",
  "dist",
  "lib",
  "client"
);

if (!fs.existsSync(clientDir)) {
  process.exit(0);
}

const shims = [
  { file: "index.js", content: 'module.exports = require("../client.cjs");\n' },
  { file: "websocket.js", content: 'module.exports = require("./websocket.cjs");\n' },
];

for (const { file, content } of shims) {
  const filePath = path.join(clientDir, file);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}
