// MCP server exposing the WhatsApp store and Todoist task creation to Claude.
//
// MCP_TRANSPORT=stdio (default): for a client running on the same machine.
// MCP_TRANSPORT=http: serves POST /mcp on MCP_PORT (default 3333), bound to
//   127.0.0.1 only, requiring "Authorization: Bearer $MCP_AUTH_TOKEN".
//   Reach it from your computer with an SSH tunnel; it is not exposed publicly.
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { openDb } from './db.js';
import * as todoist from './todoist.js';

const db = openDb();

const fmt = (rows) => ({
  content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
});

function buildServer() {
  const server = new McpServer({ name: 'whatsapp-monitor', version: '0.1.0' });

  server.tool(
    'list_chats',
    'List recent WhatsApp chats, newest activity first.',
    { limit: z.number().int().min(1).max(100).default(30) },
    async ({ limit }) => fmt(db.listChats(limit)),
  );

  server.tool(
    'get_messages',
    'Get recent messages in one chat. Pass chat_jid from list_chats. Optionally pass since (unix ms).',
    {
      chat_jid: z.string(),
      since: z.number().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ chat_jid, since, limit }) => fmt(db.getMessages({ chatJid: chat_jid, since, limit })),
  );

  server.tool(
    'search_messages',
    'Search stored message text across all chats.',
    { query: z.string().min(2), limit: z.number().int().min(1).max(100).default(25) },
    async ({ query, limit }) => fmt(db.searchMessages({ query, limit })),
  );

  server.tool(
    'unanswered_messages',
    'Incoming messages you have not replied to yet, within the last N hours.',
    {
      hours: z.number().int().min(1).max(168).default(48),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ hours, limit }) => fmt(db.unanswered({ hours, limit })),
  );

  server.tool(
    'create_task',
    'Create a Todoist task from a WhatsApp message or commitment. Confirm the title with the user before calling.',
    {
      title: z.string().min(3),
      description: z.string().optional(),
      due_string: z.string().optional().describe('Natural language due date, e.g. "tomorrow 5pm"'),
      source_chat_jid: z.string().optional(),
      source_message_id: z.string().optional(),
    },
    async ({ title, description, due_string, source_chat_jid, source_message_id }) => {
      const task = await todoist.createTask({
        content: title,
        description: [description, source_chat_jid ? `WhatsApp: ${source_chat_jid}` : null]
          .filter(Boolean)
          .join('\n') || undefined,
        dueString: due_string,
        labels: ['whatsapp'],
      });
      const localId = db.addTask({
        sourceJid: source_chat_jid,
        sourceMsg: source_message_id,
        title,
        todoistId: task.id,
      });
      return fmt({ local_id: localId, todoist_id: task.id, url: task.url });
    },
  );

  server.tool(
    'list_open_tasks',
    'List open Todoist tasks that were created from WhatsApp (label "whatsapp").',
    {},
    async () => fmt(await todoist.listTasks({ filter: '@whatsapp' })),
  );

  server.tool(
    'complete_task',
    'Mark a Todoist task as done by its Todoist id.',
    { todoist_id: z.string() },
    async ({ todoist_id }) => {
      await todoist.completeTask(todoist_id);
      return fmt({ completed: todoist_id });
    },
  );

  return server;
}

const mode = process.env.MCP_TRANSPORT || 'stdio';

if (mode === 'http') {
  const port = Number(process.env.MCP_PORT || 3333);
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) throw new Error('MCP_AUTH_TOKEN must be set for http mode');

  const httpServer = createServer((req, res) => {
    if (req.url !== '/mcp' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      } catch (err) {
        console.error('MCP request failed:', err);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
  });

  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`WhatsApp MCP listening on http://127.0.0.1:${port}/mcp`);
  });
} else {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
