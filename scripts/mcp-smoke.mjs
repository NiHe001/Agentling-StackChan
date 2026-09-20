import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
const client = new Client({ name: 'agentling-smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/mcp/index.js')] }));
try {
  const tools = await client.listTools();
  console.log('Tools:', tools.tools.map(t => t.name).join(', '));
  if (process.argv[2] === '--list-only') process.exitCode = 0;
  else {
    const name = process.argv[2] || 'agentling_diagnostics';
    const args = JSON.parse(process.argv[3] || '{}');
    console.log(JSON.stringify(await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }), null, 2));
  }
} finally { await client.close(); }
