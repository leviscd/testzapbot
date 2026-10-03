/**
 * bot.mjs - bot Baileys 7 em um unico arquivo
 *   - login por pairing code (8 caracteres)
 *   - comandos do Codigo 1 (menu por enquete, figurinhas, moderacao, etc.)
 *   - NAO encaminha nenhum log pro WhatsApp
 *   - sharp carregado sob demanda (nao quebra o boot se faltar)
 *   - codigo-fonte 100% ASCII: emojis/acentos via \u{...}, sem depender de encoding
 *
 * Rodar:  node bot.mjs      (Node >= 20)
 * Env:
 *   PAIR_CODE     pairing code customizado, exatamente 8 chars (padrao: aleatorio)
 *   PREFIX        prefixo dos comandos (padrao: ?)
 *   AUTH_DIR      pasta da sessao (padrao: ./auth)
 *   PORT          se definido, abre um HTTP "ok" (hospedagens que exigem porta)
 *   BAILEYS_LOG   error | warn | info | debug | trace (padrao: warn)
 *   WATCHDOG_MS   watchdog de conexao (padrao: 60000)
 *   ENABLE_EVAL   "true" habilita ?execute / ?exec / ?eval (owner only)
 *   OWNER_JIDS    lista separada por virgulas de JIDs do(s) dono(s)
 *   BOT_NO_START  se definido, nao inicia automaticamente (para testes)
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

/* ============================ config ============================ */
const PREFIX = process.env.PREFIX || '?';
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const PAIR_CODE = (process.env.PAIR_CODE || '').toUpperCase() || undefined;
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS) || 60_000;
const ENABLE_EVAL = process.env.ENABLE_EVAL === 'true';
const OWNER_JIDS = new Set(
  (process.env.OWNER_JIDS || '')
    .split(',')
    .map((j) => j.trim())
    .filter(Boolean)
);

/* ==================== numero fixo do bot ==================== */
const PAIR_NUMBER = '5562996664760';

/* ============================ estado ============================ */
let activeSock = null;
const setActiveSock = (s) => { activeSock = s; };

const sentCache = new Map();      // id -> message (retry / eco do proprio bot)
const messageStore = new Map();   // id -> message (reconstruir enquete)
const menuSessions = new Map();   // chave da enquete -> sessao do menu

function rememberSent(msg) {
  const id = msg?.key?.id;
  if (!id || !msg.message) return;
  sentCache.set(id, msg.message);
  if (sentCache.size > 500) sentCache.delete(sentCache.keys().next().value);
}

/* ==================== emojis como escapes unicode ==================== */
// O arquivo-fonte e ASCII puro. Estes sao os mesmos caracteres que apareciam
// nos textos originais - em runtime ficam identicos.
const E = {
  camera:  '\u{1F4F8}',           // camera
  police:  '\u{1F46E}',           // policial
  tools:   '\u{1F6E0}\u{FE0F}',   // ferramentas
  info:    '\u{2139}\u{FE0F}',    // info
  picture: '\u{1F5BC}\u{FE0F}',   // quadro
  robot:   '\u{1F916}',           // robo
  users:   '\u{1F465}',           // pessoas
  bolt:    '\u{26A1}',            // raio
  trash:   '\u{1F5D1}\u{FE0F}',   // lixeira
  up:      '\u{2B06}\u{FE0F}',    // seta pra cima
  down:    '\u{2B07}\u{FE0F}',    // seta pra baixo
  point:   '\u{261D}\u{FE0F}',    // dedinho pra cima
  x:       '\u{274C}',            // X vermelho
  ping:    '\u{1F3D3}',           // ping-pong
  clock:   '\u{23F1}\u{FE0F}',    // cronometro
  lock:    '\u{1F510}',           // cadeado
  no:      '\u{26D4}',            // proibido
  ok:      '\u{2705}',            // check verde
};

/* ==================== logger do Baileys ==================== */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const BA_LEVEL = LEVELS[process.env.BAILEYS_LOG] !== undefined ? process.env.BAILEYS_LOG : 'warn';
const BA_MAX = LEVELS[BA_LEVEL];

function safeString(v, max = 500) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v, (_k, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (val instanceof Error) return { name: val.name, message: val.message };
      if (val instanceof Uint8Array) return '<' + val.length + ' bytes>';
      return val;
    });
    return s && s.length > max ? s.slice(0, max) + '...' : s;
  } catch { return String(v); }
}

function makeLogger() {
  const emit = (lvl, a, b) => {
    if (LEVELS[lvl] > BA_MAX) return;
    const parts = ['[baileys]', b || ''].filter(Boolean);
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

/* ==================== utilitarios ==================== */
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
  return reply(sock, jid, message, { text: E.x + ' Erro: ' + (error?.message || error) });
}

/* ==================== textos do menu ==================== */
const MENU_OPTIONS = [
  E.camera + ' Figuras',
  E.police + ' Modera\u00E7\u00E3o',
  E.tools  + ' Utilit\u00E1rios',
  E.info   + ' Sobre',
];

const MENU_RESPONSES = {
  [E.camera + ' Figuras']: () =>
    '*' + E.picture + ' MENU FIGURAS*\n\n' +
    PREFIX + 's       - Responda uma imagem para converter em figurinha\n' +
    PREFIX + 'sticker - Alias de ' + PREFIX + 's\n' +
    PREFIX + 'fig     - Alias de ' + PREFIX + 's\n' +
    PREFIX + 'img     - Responda uma figurinha para converter em imagem\n' +
    PREFIX + 'toimg   - Alias de ' + PREFIX + 'img\n' +
    PREFIX + 'imagem  - Alias de ' + PREFIX + 'img',

  [E.police + ' Modera\u00E7\u00E3o']: () =>
    '*' + E.police + ' MENU MODERA\u00C7\u00C3O* (apenas admins do grupo)\n\n' +
    PREFIX + 'ban @user     - Remove um membro do grupo\n' +
    PREFIX + 'promote @user - Promove um membro a administrador\n' +
    PREFIX + 'demote @user  - Remove um membro de administrador',

  [E.tools + ' Utilit\u00E1rios']: () =>
    '*' + E.tools + ' MENU UTILIT\u00C1RIOS*\n\n' +
    PREFIX + 'menu    - Mostra este menu\n' +
    PREFIX + 'help    - Alias de ' + PREFIX + 'menu\n' +
    PREFIX + 'ping    - Verifica se o bot esta online\n' +
    PREFIX + 'uptime  - Mostra o tempo de atividade\n' +
    PREFIX + 'info    - Informacoes da mensagem respondida\n' +
    PREFIX + 'execute <code> - Executa JS (owner, se habilitado)\n' +
    PREFIX + 'exec    - Alias de ' + PREFIX + 'execute\n' +
    PREFIX + 'eval    - Alias de ' + PREFIX + 'execute',

  [E.info + ' Sobre']: () =>
    '*' + E.info + ' SOBRE O BOT*\n\n' +
    E.robot + ' SyntraxBot v1.1\n' +
    'Bot de WhatsApp usando Baileys\n' +
    E.users + ' Suporte a grupos e privados\n' +
    E.bolt + ' Comandos: ' + PREFIX + 'menu\n\n' +
    'Prefix: ' + PREFIX,
};

const GROUP_ACTION_LABELS = {
  remove:  E.trash + ' Membro removido do grupo!',
  promote: E.up + ' Usu\u00E1rio promovido a administrador!',
  demote:  E.down + ' Administrador rebaixado.',
};

/* ==================== enquete / menu ==================== */
function getPollUpdate(message) {
  return unwrap(message).pollUpdateMessage || null;
}

function pollKeyStr(key) {
  return key ? key.remoteJid + ':' + key.id : '';
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
    { text: '*Selecione uma categoria acima ' + E.point + '*' },
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

/* ==================== sharp (lazy) ==================== */
let sharpPromise = null;
function getSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((m) => m.default || m)
      .catch((e) => {
        sharpPromise = null;
        throw new Error(
          'sharp nao esta disponivel neste ambiente - adicione "sharp" nas dependencias. Detalhe: ' +
            (e?.message || e)
        );
      });
  }
  return sharpPromise;
}

/* ==================== conversao de midia ==================== */
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
      await reply(sock, jid, message, { text: 'Responda uma figurinha com ' + PREFIX + 'img' });
      return;
    }
    const sharp = await getSharp();
    const buf = await downloadAsBuffer(sticker, 'image');
    const image = await sharp(buf).png().toBuffer();
    await reply(sock, jid, message, { image, caption: E.picture + ' Sua imagem' });
  } catch (error) {
    console.error('stickerToImage:', error?.stack || error);
    await replyError(sock, jid, message, error);
  }
}

async function imageToSticker(sock, message, jid) {
  try {
    const image = unwrap(message).imageMessage;
    if (!image) {
      await reply(sock, jid, message, { text: 'Responda uma imagem com ' + PREFIX + 's' });
      return;
    }
    const sharp = await getSharp();
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

/* ==================== comandos de grupo ==================== */
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
    await reply(sock, jid, message, { text: 'Este comando so funciona em grupos.' });
    return;
  }

  const group = await getGroupInfo(sock, jid, sender);

  if (!group.isAdmin) {
    await reply(sock, jid, message, {
      text: E.police + ' Apenas administradores podem usar este comando.',
    });
    return;
  }
  if (!group.isBotAdmin) {
    await reply(sock, jid, message, {
      text: E.robot + ' Eu preciso ser administrador do grupo para isso.',
    });
    return;
  }

  const mentions = mentionedJidsOf(message);
  if (!mentions.length) {
    await reply(sock, jid, message, { text: 'Use: ' + PREFIX + action + ' @usuario' });
    return;
  }

  try {
    await sock.groupParticipantsUpdate(jid, [mentions[0]], action);
    await reply(sock, jid, message, {
      text: GROUP_ACTION_LABELS[action] || 'Acao realizada!',
    });
  } catch (error) {
    console.error('handleGroupAction:', error?.stack || error);
    await replyError(sock, jid, message, error);
  }
}

/* ==================== info da mensagem ==================== */
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

/* ==================== execucao de codigo (owner) ==================== */
async function executeCode(sock, jid, sender, code, message) {
  if (!ENABLE_EVAL) {
    await reply(sock, jid, message, { text: E.no + ' Execucao de codigo esta desativada.' });
    return;
  }
  if (!isOwner(sender)) {
    await reply(sock, jid, message, {
      text: E.lock + ' Apenas o proprietario pode executar codigo.',
    });
    return;
  }
  if (!code.trim()) {
    await reply(sock, jid, message, { text: 'Uso: ' + PREFIX + 'execute <codigo JavaScript>' });
    return;
  }

  try {
    const result = await new Function(
      'socket',
      'jid',
      'sender',
      'msg',
      'sleep',
      'return (async () => {\n' + code + '\n})()'
    )(sock, jid, sender, message, sleep);

    const output =
      result === undefined
        ? E.ok + ' Executado sem retorno'
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

/* ==================== tabela de comandos ==================== */
const COMMAND_HANDLERS = {
  menu: ({ sock, jid, sender }) => sendMenu(sock, jid, sender),
  help: ({ sock, jid, sender }) => sendMenu(sock, jid, sender),

  ping: ({ sock, jid, message }) => reply(sock, jid, message, { text: E.ping + ' Pong!' }),

  uptime: ({ sock, jid, message }) => {
    const u = Math.floor(process.uptime());
    const h = Math.floor(u / 3600);
    const m = Math.floor((u % 3600) / 60);
    const s = u % 60;
    return reply(sock, jid, message, {
      text: E.clock + ' Bot ativo ha ' + h + 'h ' + m + 'm ' + s + 's',
    });
  },

  info: ({ sock, jid, message }) => sendMessageInfo(sock, jid, message),

  s:       ({ sock, jid, message }) => imageToSticker(sock, message, jid),
  sticker: ({ sock, jid, message }) => imageToSticker(sock, message, jid),
  fig:     ({ sock, jid, message }) => imageToSticker(sock, message, jid),

  img:    ({ sock, jid, message }) => stickerToImage(sock, message, jid),
  toimg:  ({ sock, jid, message }) => stickerToImage(sock, message, jid),
  imagem: ({ sock, jid, message }) => stickerToImage(sock, message, jid),

  ban:     ({ sock, jid, sender, message }) => handleGroupAction(sock, jid, sender, 'remove', message),
  promote: ({ sock, jid, sender, message }) => handleGroupAction(sock, jid, sender, 'promote', message),
  demote:  ({ sock, jid, sender, message }) => handleGroupAction(sock, jid, sender, 'demote', message),

  execute: ({ sock, jid, sender, body, message }) => executeCode(sock, jid, sender, body, message),
  exec:    ({ sock, jid, sender, body, message }) => executeCode(sock, jid, sender, body, message),
  eval:    ({ sock, jid, sender, body, message }) => executeCode(sock, jid, sender, body, message),
};

/* ==================== handler de mensagem ==================== */
async function onMessage(sock, m) {
  if (!m?.message || !m.key?.remoteJid) return;
  const jid = m.key.remoteJid;
  if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  if (m.key.id && sentCache.has(m.key.id)) return;

  const ts = Number(m.messageTimestamp);
  if (ts && Date.now() / 1000 - ts > 90) return;

  storeMessage(m);

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
      text: E.x + ' Comando nao encontrado. Use ' + PREFIX + 'menu para ver as opcoes.',
    });
    return;
  }

  try {
    await handler({ sock, jid, sender, message: m, args, body });
  } catch (error) {
    console.error('erro no comando ' + PREFIX + command + ':', error?.stack || error);
    await reply(sock, jid, m, {
      text: E.x + ' Erro ao processar comando: ' + String(error?.message || error).slice(0, 100),
    });
  }
}

/* ==================== conexao + pairing code ==================== */
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch (e) {
    console.warn('nao consegui buscar a versao mais recente do WA, usando a padrao:', e?.message);
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

  let reached = false;
  let closedSeen = false;
  const watchdog = setTimeout(() => {
    if (reached) return;
    console.error(
      '[watchdog] ' + (WATCHDOG_MS / 1000) + 's sem conseguir falar com o WhatsApp ' +
      '(hospedagem bloqueando saida? DNS? firewall?). Tentando de novo...'
    );
    try { sock.end(new Error('watchdog: sem conexao')); }
    catch (e) { console.error('sock.end falhou:', e?.message); }
    setTimeout(() => { if (!closedSeen) boot(); }, 5000);
  }, WATCHDOG_MS);

  let pairingRequested = false;
  const askPairing = async () => {
    if (pairingRequested || closedSeen || sock.authState.creds.registered) return;
    pairingRequested = true;
    try {
      const code = await sock.requestPairingCode(PAIR_NUMBER, PAIR_CODE);
      const pretty = code.match(/.{1,4}/g).join('-');
      console.log(
        '\n==========================================\n' +
        '   NUMERO: ' + PAIR_NUMBER + '\n' +
        '   CODIGO DE PAREAMENTO:  ' + pretty + '\n' +
        '   WhatsApp > Aparelhos conectados > Conectar\n' +
        '   aparelho > Conectar com numero de telefone\n' +
        '==========================================\n'
      );
    } catch (e) {
      pairingRequested = false;
      const short = String(e?.stack || e).split('\n').slice(0, 3).join(' | ');
      console.error('falha ao pedir o pairing code: ' + short);
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
    if (connection) console.log('connection.update -> ' + connection);

    if (connection === 'open') {
      console.log('CONECTADO como ' + sock.user?.id + (sock.user?.lid ? ' (lid ' + sock.user.lid + ')' : ''));
      console.log('Mande ' + PREFIX + 'menu pra este numero (ou pra voce mesmo, em "Conversar comigo").');
    }

    if (connection === 'close') {
      closedSeen = true;
      clearTimeout(watchdog);
      if (activeSock === sock) setActiveSock(null);
      const err = lastDisconnect?.error;
      const code = err?.output?.statusCode;
      console.error('CONEXAO FECHADA: code=' + code + ' (' + (DisconnectReason[code] ?? 'desconhecido') + ') - ' + err?.message);

      if (code === DisconnectReason.loggedOut) {
        console.error('Sessao deslogada: apagando a pasta de sessao e pareando de novo.');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.error('Sessao aberta em OUTRO lugar (440). Nao vou reconectar pra nao brigar com a outra instancia.');
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

/* ==================== HTTP health (opcional) ==================== */
if (process.env.PORT) {
  http
    .createServer((_q, r) => r.end('bot ok'))
    .listen(process.env.PORT, () => console.log('http na porta ' + process.env.PORT));
}

if (!process.env.BOT_NO_START) boot();

// exportado so pra testes offline
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
  PAIR_NUMBER,
};
