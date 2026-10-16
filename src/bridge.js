// WhatsApp bridge for a personal account, using Baileys as a linked device.
// Read-only by design: it stores incoming and outgoing messages and never sends.
//
// Unofficial library. WhatsApp's terms do not allow it, and the account can be
// restricted. Keep one linked device and avoid automated sending.
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { openDb } from './db.js';

const AUTH_DIR = process.env.AUTH_DIR || './data/auth';
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const db = openDb();

// Keep messages only this many days, to limit how much personal data is stored.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);

function extractBody(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    (m.imageMessage ? '[image]' : null) ||
    (m.audioMessage ? '[audio]' : null) ||
    (m.documentMessage ? `[document] ${m.documentMessage.fileName ?? ''}` : null) ||
    null
  );
}

function prune() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400 * 1000;
  db.raw.prepare('DELETE FROM messages WHERE timestamp < ?').run(cutoff);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Scan this QR with WhatsApp > Linked devices:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('WhatsApp connected.');
      prune();
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`Connection closed (code ${code}).`, loggedOut ? 'Logged out; delete AUTH_DIR and re-link.' : 'Reconnecting in 15s.');
      if (!loggedOut) setTimeout(start, 15000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = live messages. Ignore 'append' (history) to keep the store clean.
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

      // Skip protocol/system messages (reactions, receipts, key exchange) that have no text.
      const body = extractBody(msg);
      if (body === null) continue;

      const chatJid = msg.key.remoteJid;
      const isGroup = chatJid.endsWith('@g.us');
      db.insertMessage({
        id: msg.key.id,
        chatJid,
        // For 1:1 chats, the incoming sender's push name is the contact's name.
        chatName: !isGroup && !msg.key.fromMe ? msg.pushName ?? undefined : undefined,
        sender: msg.key.participant || chatJid,
        senderName: msg.pushName ?? null,
        fromMe: msg.key.fromMe,
        body,
        timestamp: Number(msg.messageTimestamp) * 1000,
      });
    }
  });

  sock.ev.on('chats.upsert', (chats) => {
    for (const c of chats) {
      db.upsertChat({ jid: c.id, name: c.name, isGroup: c.id.endsWith('@g.us') });
    }
  });

  // Contact names arrive here, including for @lid contacts that have no phone number.
  const onContacts = (contacts) => {
    for (const c of contacts) {
      const name = c.name || c.notify;
      if (name) db.upsertChat({ jid: c.id, name, isGroup: c.id.endsWith('@g.us') });
    }
  };
  sock.ev.on('contacts.upsert', onContacts);
  sock.ev.on('contacts.update', onContacts);
}

start().catch((err) => {
  console.error('Bridge failed to start:', err);
  process.exit(1);
});
