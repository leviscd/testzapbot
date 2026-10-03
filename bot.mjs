/**
 * bot.mjs — bot Baileys 7 em um único arquivo
 *   • login por pairing code (8 caracteres)
 *   • comandos baseados no Código 1 (menu por enquete, figurinhas, moderação etc.)
 *   • NÃO encaminha nenhum log pro WhatsApp
 *
 * Rodar:  PAIR_NUMBER=5562999999999 node bot.mjs      (Node >= 20)
 * Env:
 *   PAIR_NUMBER   número do bot com DDI+DDD+9 (só dígitos). Sem isso o bot pergunta no console
 *   PAIR_CODE     pairing code customizado, exatamente 8 chars (padrão: aleatório)
 *   PREFIX        prefixo dos comandos (padrão: ?)
 *   AUTH_DIR      pasta da sessão (padrão: ./auth)
 *   PORT          se definido, abre um HTTP "ok" (hospedagens que exigem porta)
 *   BAILEYS_LOG   error | warn | info | debug | trace (padrão: warn)
 *   WATCHDOG_MS   watchdog de conexão (padrão: 60000)
 *   ENABLE_EVAL   "true" habilita ?execute / ?exec / ?eval (owner only)
 *   OWNER_JIDS    lista separada por vírgulas de JIDs do(s) dono(s)
 *   BOT_NO_START  se definido, não inicia automaticamente (para testes)
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  getAggregateVotesInPollMessage,
} from '@whiskeysockets/baileys';
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline/promises';
import sharp from 'sharp';

/* ═════════════════════════ config ═════════════════════════ */
const PREFIX = process.env.PREFIX || '?';
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const PAIR_CODE = ('5562996664760').toUpperCase() || undefined;
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS) || 60_000;
const ENABLE_EVAL = process.env.ENABLE_EVAL === 'true';
const OWNER_JIDS = new Set(
  (process.env.OWNER_JIDS || '')
    .split(',')
    .map((j) => j.trim())
    .filter(Boolean)
);
let pairNumber = (process.env.PAIR_NUMBER || '').replace(/\D/g, '');

/* ═════════════════════════ estado ═════════════════════════ */
let activeSock = null;
const setActiveSock = (s) => { activeSock = s; };

const sentCache = new Map();      // id → message (para o Baileys pedir em retry / eco)
const messageStore = new Map();   // id → message (para reconstruir a enquete)
const menuSessions = new Map();   // chave da enquete → sessão do menu

function rememberSent(msg) {
  const id = msg?.key?.id;
  if (!id || !msg.message) return;
  sentCache.set(id, msg.message);
  if (sentCache.size > 500) sentCache.delete(sentCache.keys().next().value);
}

/* ═════════════════════════ logger do Baileys ═════════════════════════ */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const BA_LEVEL = LEVELS[process.env.BAILEYS_LOG] !== undefined ? process.env.BAILEYS_LOG : 'warn';
const BA_MAX = LEVELS[BA_LEVEL];

function safeString(v, max = 500) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v, (_k, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (val instanceof Error) return { name: val.name, message: val.message };
      if (val instanceof Uint8Array) return `<${val.length} bytes>`;
      return val;
    });
    return s && s.length > max ? s.slice(0, max) + '…' : s;
  } catch { return String(v); }
}

function makeLogger() {
  const emit = (lvl, a, b) => {
    if (LEVELS[lvl] > BA_MAX) return;
    const parts = [`[baileys]`, b || ''].filter(Boolean);
    if (a !== undefined && a !== null) {
      parts.push(a instanceof Error ? (a.stack || a.message) : safeString(a));
    }
    const fn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    fn(...parts);
  };
  const lg = {
    level: 'trace',
    child: () => lg,
    trace: (o, m) => emit('trace', o, m),
    debug: (o, m) => emit('debug', o, m),
    info:  (o, m) => emit('info',  o, m),
    warn:  (o, m) => emit('warn',  o, m),
    error: (o, m) => emit('error', o, m),
  };
  return lg;
}

/* ═════════════════════════ utilitários ═════════════════════════ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeJid = (jid) => String(jid || '').replace(/:.*/, '').trim().toLowerCase();
const isGroup = (jid) => jid?.endsWith('@g.us') ?? false;
const isOwner = (jid) => OWNER_JIDS.has(normalizeJid(jid));

function unwrap(message) {
  let content = message?.message;
  while (content) {
    const wrapper =
      content.ephemeralMessage ||
      content.viewOnceMessage ||
      content.viewOnceMessageV2 ||
      content.documentWithCaptionMessage;
    if (!wrapper?.message) break;
    content = wrapper.message;
  }
  return content || {};
}

function textOf(message) {
  const c = unwrap(message);
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    c.buttonsResponseMessage?.selectedButtonId ||
    c.listResponseMessage?.singleSelectReply?.selectedRowId ||
    c.templateButtonReplyMessage?.selectedId ||
    ''
  ).trim();
}

function senderOf(message) {
  return message.key.participant || message.key.remoteJid || '';
}

function storeMessage(message) {
  if (!message?.key?.id) return;
  messageStore.set(message.key.id, message);
  if (messageStore.size > 1000) messageStore.delete(messageStore.keys().next().value);
}

async function reply(sock, jid, message, content) {
  const sent = await sock.sendMessage(jid, content, { quoted: message });
  rememberSent(sent);
  return sent;
}

async function replyError(sock, jid, message, error) {
  return reply(sock, jid, message, { text: `❌ Erro: ${error?.message || error}` });
}

/* ═════════════════════════ textos do menu ═════════════════════════ */
const MENU_OPTIONS = ['📸 Figuras', '👮 Moderação', '🛠️ Utilitários', 'ℹ️ Sobre'];

const MENU_RESPONSES = {
  '📸 Figuras': () =>
    `*🖼️ MENU FIGURAS*\n\n${PREFIX}s - Responda uma figurinha para converter em imagem\n${PREFIX}img - Responda uma imagem para converter em figurinha\n${PREFIX}fig - Alias de figurinha`,
  '👮 Moderação': () =>
    `*👮 MENU MODERAÇÃO* (Apenas admins)\n\n${PREFIX}ban @user - Remove um membro\n${PREFIX}promote @user - Promove a administrador\n${PREFIX}demote @user - Remove de administrador`,
  '🛠️ Utilitários': () =>
    `*🛠️ MENU UTILITÁRIOS*\n\n${PREFIX}ping - Verifica se o bot está online\n${PREFIX}uptime - Mostra tempo de atividade\n${PREFIX}info - Informações da mensagem`,
  'ℹ️ Sobre': () =>
    `*ℹ️ SOBRE O BOT*\n\n🤖 SyntraxBot v1.1\nBot de WhatsApp usando Baileys\n👥 Suporte a grupos e privados\n⚡ Comandos: ${PREFIX}menu\n\nPrefix: ${PREFIX}`,
};

const GROUP_ACTION_LABELS = {
  remove: '🗑️ Membro removido do grupo!',
  promote: '⬆️ Usuário promovido a administrador!',
  demote: '⬇️ Administrador rebaixado.',
};

/* ═════════════════════════ enquete / menu ═════════════════════════ */
function getPollUpdate(message) {
  return unwrap(message).pollUpdateMessage || null;
}

function pollKeyStr(key) {
  return key ? `${key.remoteJid}:${key.id}` : '';
}

function getPollCreationKey(update) {
  return update?.pollCreationMessageKey || update?.pollCreationMessage?.key || null;
}

async function sendMenu(sock, jid, sender) {
  const poll = await sock.sendMessage(jid, {
    poll: {
      name: 'Menu SyntraxBot',
      values: MENU_OPTIONS,
      selectableCount: 1,
    },
  });
  rememberSent(poll);
  if (poll?.key?.id) messageStore.set(poll.key.id, poll);

  const response = await sock.sendMessage(
    jid,
    { text: '*Selecione uma categoria acima ☝️*' },
    { quoted: poll }
  );
  rememberSent(response);

  if (poll?.key?.id && response?.key?.id) {
    menuSessions.set(pollKeyStr(poll.key), {
      jid,
      sender: normalizeJid(sender),
      responseKey: response.key,
      pollKey: poll.key,
      createdAt: Date.now(),
    });
  }
}

async function handleMenuPoll(sock, message) {
  const update = getPollUpdate(message);
  if (!update) return false;

  const pollKey = getPollCreationKey(update);
  if (!pollKey) return false;

  const session = menuSessions.get(pollKeyStr(pollKey));
  if (!session) return true;

  const voter = update.voterJid || message.key.participant || message.key.remoteJid;
  if (normalizeJid(voter) !== session.sender) return true;

  const votes = getAggregateVotesInPollMessage({
    message: messageStore.get(pollKey.id),
    pollUpdates: [message],
  });

  const selected = MENU_OPTIONS.find((option) => votes?.[option]?.length > 0);
  if (!selected) return true;

  try {
    await sock.sendMessage(session.jid, {
      text: MENU_RESPONSES[selected](),
      edit: session.responseKey,
    });
  } catch (e) {
    console.error('erro ao editar resposta do menu:', e?.message || e);
  }
  menuSessions.delete(pollKeyStr(pollKey));
  return true;
}

/* ═════════════════════════ conversão de mídia ═════════════════════════ */
async function downloadAsBuffer(mediaMessage, mediaType) {
  const stream = await downloadContentFromMessage(mediaMessage, mediaType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function stickerToImage(sock, message, jid) {
  try {
    const sticker = unwrap(message).stickerMessage;
    if (!sticker) {
      await reply(sock, jid, message, { text: `Responda uma figurinha com ${PREFIX}img` });
      return;
    }
    const buf = await downloadAsBuffer(sticker, 'image');
    const image = await sharp(buf).png().toBuffer();
    await reply(sock, jid, message, { image, caption: '🖼️ Sua imagem' });
  } catch (error) {
    console.error('stickerToImage:', error?.stack || error);
    await replyError(sock, jid, message, error);
  }
}

async function imageToSticker(sock, message, jid) {
  try {
    const image = unwrap(message).imageMessage;
    if (!image) {
      await reply(sock, jid, message, { text: `Responda uma imagem com ${PREFIX}s` });
      return;
    }
    const buf = await downloadAsBuffer(image, 'image');
    const webp = await sharp(buf)
      .resize(512, 512, { fit: 'cover', withoutEnlargement: false })
      .webp()
      .toBuffer();
    await reply(sock, jid, message, { sticker: webp });
  } catch (error) {
    console.error('imageToSticker:', error?.stack || error);
    await replyError(sock, jid, message, error);
  }
}

/* ═════════════════════════ comandos de grupo ═════════════════════════ */
async function getGroupInfo(sock, jid, sender) {
  const metadata = await sock.groupMetadata(jid);
  const senderParticipant = metadata.participants.find(
    (p) => normalizeJid(p.id) === normalizeJid(sender)
  );
  const botParticipant = metadata.participants.find(
    (p) => normalizeJid(p.id) === normalizeJid(sock.user.id)
  );
  return {
    jid,
    isAdmin:
      senderParticipant?.admin === 'admin' || senderParticipant?.admin === 'superadmin',
    isBotAdmin:
      botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin',
  };
}

function mentionedJidsOf(message) {
  const c = unwrap(message);
  return c.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

async function handleGroupAction(sock, jid, sender, action, message) {
  if (!isGroup(jid)) {
    await reply(sock, jid, message, { text: 'Este comando só funciona em grupos.' });
    return;
  }

  const group = await getGroupInfo(sock, jid, sender);

  if (!group.isAdmin) {
    await reply(sock, jid, message, {
      text: '👮 Apenas administradores podem usar este comando.',
    });
    return;
  }
  if (!group.isBotAdmin) {
    await reply(sock, jid, message, {
      text: '🤖 Eu preciso ser administrador do grupo para isso.',
    });
    return;
  }

  const mentions = mentionedJidsOf(message);
  if (!mentions.length) {
    await reply(sock, jid, message, { text: `Use: ${PREFIX}${action} @usuario` });
    return;
  }

  try {
    await sock.groupParticipantsUpdate(jid, [mentions[0]], action);
    await reply(sock, jid, message, {
      text: GROUP_ACTION_LABELS[action] || 'Ação realizada!',
    });
  } catch (error) {
    console.error('handleGroupAction:', error?.stack || error);
    await replyError(sock, jid, message, error);
  }
}

/* ═════════════════════════ info da mensagem ═════════════════════════ */
async function sendMessageInfo(sock, jid, message) {
  try {
    const content = unwrap(message);
    const info = {
      remoteJid: message.key.remoteJid,
      messageId: message.key.id,
      timestamp: new Date(Number(message.messageTimestamp) * 1000),
      fromMe: message.key.fromMe,
      sender: senderOf(message),
      text: textOf(message).slice(0, 100),
      contentType: Object.keys(content)[0] || 'unknown',
      hasMedia:
        !!content.imageMessage || !!content.videoMessage || !!content.documentMessage,
      isQuoted: !!content.extendedTextMessage?.contextInfo?.quotedMessage,
      mentions: content.extendedTextMessage?.contextInfo?.mentionedJid || [],
    };
    const formatted = JSON.stringify(info, null, 2);
    const output = formatted.length > 4096 ? formatted.slice(0, 4000) + '...' : formatted;
    await reply(sock, jid, message, { text: '```\n' + output + '\n```' });
  } catch (error) {
    console.error('sendMessageInfo:', error?.stack || error);
    await replyError(sock, jid, message, error);
  }
}

/* ═════════════════════════ execução de código (owner) ═════════════════════════ */
async function executeCode(sock, jid, sender, code, message) {
  if (!ENABLE_EVAL) {
    await reply(sock, jid, message, { text: '⛔ Execução de código está desativada.' });
    return;
  }
  if (!isOwner(sender)) {
    await reply(sock, jid, message, {
      text: '🔐 Apenas o proprietário pode executar código.',
    });
    return;
  }
  if (!code.trim()) {
    await reply(sock, jid, message, { text: `Uso: ${PREFIX}execute <código JavaScript>` });
    return;
  }

  try {
    const result = await new Function(
      'socket',
      'jid',
      'sender',
      'msg',
      'sleep',
      `return (async () => {\n${code}\n})()`
    )(sock, jid, sender, message, sleep);

    const output =
      result === undefined
        ? '✅ Executado sem retorno'
        : typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2);

    await reply(sock, jid, message, { text: '```\n' + output.slice(0, 4000) + '\n```' });
  } catch (error) {
    console.error('executeCode:', error?.stack || error);
    await reply(sock, jid, message, {
      text: '```\n' + String(error?.message || error).slice(0, 500) + '\n```',
    });
  }
}

/* ═════════════════════════ tabela de comandos ═════════════════════════ */
const COMMAND_HANDLERS = {
  menu: ({ sock, jid, sender }) => sendMenu(sock, jid, sender),
  help: ({ sock, jid, sender }) => sendMenu(sock, jid, sender),

  ping: ({ sock, jid, message }) => reply(sock, jid, message, { text: '🏓 Pong!' }),

  uptime: ({ sock, jid, message }) => {
    const u = Math.floor(process.uptime());
    const h = Math.floor(u / 3600);
    const m = Math.floor((u % 3600) / 60);
    const s = u % 60;
    return reply(sock, jid, message, { text: `⏱️ Bot ativo há ${h}h ${m}m ${s}s` });
  },

  info: ({ sock, jid, message }) => sendMessageInfo(sock, jid, message),

  // "s"/"fig"/"sticker" → imagem → figurinha
  s: ({ sock, jid, message }) => imageToSticker(sock, message, jid),
  sticker: ({ sock, jid, message }) => imageToSticker(sock, message, jid),
  fig: ({ sock, jid, message }) => imageToSticker(sock, message, jid),

  // "img"/"toimg"/"imagem" → figurinha → imagem
  img: ({ sock, jid, message }) => stickerToImage(sock, message, jid),
  toimg: ({ sock, jid, message }) => stickerToImage(sock, message, jid),
  imagem: ({ sock, jid, message }) => stickerToImage(sock, message, jid),

  ban: ({ sock, jid, sender, message }) =>
    handleGroupAction(sock, jid, sender, 'remove', message),
  promote: ({ sock, jid, sender, message }) =>
    handleGroupAction(sock, jid, sender, 'promote', message),
  demote: ({ sock, jid, sender, message }) =>
    handleGroupAction(sock, jid, sender, 'demote', message),

  execute: ({ sock, jid, sender, body, message }) =>
    executeCode(sock, jid, sender, body, message),
  exec: ({ sock, jid, sender, body, message }) =>
    executeCode(sock, jid, sender, body, message),
  eval: ({ sock, jid, sender, body, message }) =>
    executeCode(sock, jid, sender, body, message),
};

/* ═════════════════════════ handler de mensagem ═════════════════════════ */
async function onMessage(sock, m) {
  if (!m?.message || !m.key?.remoteJid) return;
  const jid = m.key.remoteJid;
  if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  if (m.key.id && sentCache.has(m.key.id)) return;

  const ts = Number(m.messageTimestamp);
  if (ts && Date.now() / 1000 - ts > 90) return; // ignora fila offline antiga

  storeMessage(m);

  // Enquete: tratamos ANTES de descartar fromMe, porque o voto chega como recebido
  if (getPollUpdate(m)) {
    try {
      await handleMenuPoll(sock, m);
    } catch (e) {
      console.error('handleMenuPoll:', e?.stack || e);
    }
    return;
  }

  if (m.key.fromMe) return;

  const text = textOf(m);
  if (!text.startsWith(PREFIX)) return;

  const parts = text.slice(PREFIX.length).trim().split(/\s+/);
  const command = (parts.shift() || '').toLowerCase();
  const args = parts;
  const body = args.join(' ');
  const sender = senderOf(m);

  const handler = COMMAND_HANDLERS[command];
  if (!handler) {
    await reply(sock, jid, m, {
      text: `❌ Comando não encontrado. Use ${PREFIX}menu para ver as opções.`,
    });
    return;
  }

  try {
    await handler({ sock, jid, sender, message: m, args, body });
  } catch (error) {
    console.error(`erro no comando ${PREFIX}${command}:`, error?.stack || error);
    await reply(sock, jid, m, {
      text: `❌ Erro ao processar comando: ${String(error?.message || error).slice(0, 100)}`,
    });
  }
}

/* ═════════════════════════ conexão + pairing code ═════════════════════════ */
async function getPairNumber() {
  if (pairNumber) return pairNumber;
  console.log('Digite o número do bot com DDI+DDD+9 (só dígitos, ex: 5562999999999) e dê Enter:');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question('> ', { signal: AbortSignal.timeout(180_000) });
    pairNumber = ans.replace(/\D/g, '');
  } finally {
    rl.close();
  }
  if (pairNumber.length < 10 || pairNumber.length > 15) {
    pairNumber = '';
    throw new Error('número inválido');
  }
  return pairNumber;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch (e) {
    console.warn('não consegui buscar a versão mais recente do WA, usando a padrão:', e?.message);
  }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger: makeLogger(),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => sentCache.get(key.id),
  });
  setActiveSock(sock);
  sock.ev.on('creds.update', saveCreds);

  // Watchdog: se a hospedagem bloqueia saída/DNS, o Baileys pode ficar mudo.
  let reached = false;
  let closedSeen = false;
  const watchdog = setTimeout(() => {
    if (reached) return;
    console.error(
      `⏱ ${WATCHDOG_MS / 1000}s sem conseguir falar com o WhatsApp (hospedagem bloqueando saída? DNS? firewall?). Tentando de novo…`
    );
    try { sock.end(new Error('watchdog: sem conexão')); } catch (e) { console.error('sock.end falhou:', e?.message); }
    setTimeout(() => { if (!closedSeen) boot(); }, 5000);
  }, WATCHDOG_MS);

  let pairingRequested = false;
  const askPairing = async () => {
    if (pairingRequested || closedSeen || sock.authState.creds.registered) return;
    pairingRequested = true;
    try {
      const number = await getPairNumber();
      const code = await sock.requestPairingCode(number, PAIR_CODE);
      const pretty = code.match(/.{1,4}/g).join('-');
      console.log(
        `\n╔══════════════════════════════════════════╗\n` +
        `   CÓDIGO DE PAREAMENTO:  ${pretty}\n` +
        `   WhatsApp › Aparelhos conectados › Conectar\n` +
        `   aparelho › Conectar com número de telefone\n` +
        `╚══════════════════════════════════════════╝\n`
      );
    } catch (e) {
      pairingRequested = false;
      const short = String(e?.stack || e).split('\n').slice(0, 3).join(' | ');
      console.error(`falha ao pedir o pairing code${pairNumber ? '' : ' (sem número: defina PAIR_NUMBER)'}: ${short}`);
    }
  };
  if (!sock.authState.creds.registered) setTimeout(askPairing, 8000).unref();

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr || connection === 'open') {
      reached = true;
      clearTimeout(watchdog);
    }
    if (qr) askPairing();
    if (connection) console.log(`connection.update → ${connection}`);

    if (connection === 'open') {
      console.log(`✅ Conectado como ${sock.user?.id}${sock.user?.lid ? ` (lid ${sock.user.lid})` : ''}`);
      console.log(`Mande ${PREFIX}menu pra este número (ou pra você mesmo, em "Conversar comigo").`);
    }

    if (connection === 'close') {
      closedSeen = true;
      clearTimeout(watchdog);
      if (activeSock === sock) setActiveSock(null);
      const err = lastDisconnect?.error;
      const code = err?.output?.statusCode;
      console.error(`❌ conexão fechada: code=${code} (${DisconnectReason[code] ?? 'desconhecido'}) — ${err?.message}`);

      if (code === DisconnectReason.loggedOut) {
        console.error('Sessão deslogada: apagando a pasta de sessão e pareando de novo.');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.error('Sessão aberta em OUTRO lugar (440). Não vou reconectar pra não brigar com a outra instância.');
        return;
      }
      setTimeout(boot, code === DisconnectReason.restartRequired ? 500 : 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        await onMessage(sock, m);
      } catch (e) {
        console.error('erro no handler de mensagem:', e?.stack || e);
      }
    }
  });
}

function boot() {
  start().catch((e) => {
    console.error('erro ao iniciar:', e?.stack || e);
    setTimeout(boot, 5000);
  });
}

/* ═════════════════════════ HTTP health (opcional) ═════════════════════════ */
if (process.env.PORT) {
  http
    .createServer((_q, r) => r.end('bot ok'))
    .listen(process.env.PORT, () => console.log(`http na porta ${process.env.PORT}`));
}

if (!process.env.BOT_NO_START) boot();

// exportado só pra testes offline
export {
  start,
  boot,
  onMessage,
  COMMAND_HANDLERS,
  sendMenu,
  handleMenuPoll,
  imageToSticker,
  stickerToImage,
  handleGroupAction,
  executeCode,
  sendMessageInfo,
  makeLogger,
  sentCache,
  messageStore,
  menuSessions,
  setActiveSock,
};
