/**
 * bot.mjs — bot de TESTE (Baileys 7) em um único arquivo
 *   • login por pairing code (8 caracteres)
 *   • ?testbutton → manda 5 variações de botão pra você ver quais aparecem no celular
 *   • todo console.log/warn/error, logs do Baileys e o XML das mensagens de teste
 *     são encaminhados pro PRÓPRIO número do bot ("Conversar comigo")
 *
 * Rodar:  PAIR_NUMBER=5562999999999 node bot.mjs      (Node >= 20)
 * Env opcionais:
 *   PAIR_NUMBER  número do bot com DDI+DDD+9 (só dígitos). Sem isso o bot pergunta no console
 *   PAIR_CODE    pairing code customizado, exatamente 8 chars (padrão: aleatório)
 *   PREFIX       prefixo dos comandos (padrão: ?)
 *   LOG_TO_WA    0 = não encaminha logs pro WhatsApp (padrão: 1)
 *   BAILEYS_LOG  error | warn | info — nível dos logs do Baileys (padrão: info)
 *   AUTH_DIR     pasta da sessão (padrão: ./auth)
 *   PORT         se definido, abre um HTTP "ok" (hospedagens que exigem porta)
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  generateMessageIDV2,
  jidNormalizedUser,
  isJidGroup,
  normalizeMessageContent,
  delay,
} from '@whiskeysockets/baileys';
import { format } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline/promises';

/* ═════════════════════════ config ═════════════════════════ */
const PREFIX = process.env.PREFIX || '?';
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const PAIR_CODE = (process.env.PAIR_CODE || '').toUpperCase() || undefined;
const LOG_TO_WA = process.env.LOG_TO_WA !== '0';
const BAILEYS_LOG = ['error', 'warn', 'info'].includes(process.env.BAILEYS_LOG) ? process.env.BAILEYS_LOG : 'info';
const LOG_MARK = '📟'; // toda mensagem de log começa com isso (o bot ignora ela mesma)
const CHUNK = 3000; // tamanho máx. de cada mensagem de log
const MAX_LOG_MSGS_PER_MIN = 10; // trava anti-flood / anti-ban
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS) || 60_000; // sem falar com o WA nesse tempo = avisa e tenta de novo
let pairNumber = (process.env.PAIR_NUMBER || '').replace(/\D/g, '');

/* ═════════ 1. captura de console → fila → WhatsApp ═════════ */
const origConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const logQueue = [];
let droppedLines = 0;
let activeSock = null; // socket conectado (null enquanto offline)
let pauseFlush = false;
let flushing = false;
const sendTimes = [];

const setActiveSock = (s) => { activeSock = s; };

function pushLog(level, text) {
  const t = new Date().toISOString().slice(11, 19);
  const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '•';
  logQueue.push(`${t} ${tag} ${String(text).replaceAll('```', "'''")}`);
  if (logQueue.length > 400) { logQueue.shift(); droppedLines++; }
}

for (const lvl of ['log', 'info', 'warn', 'error']) {
  console[lvl] = (...args) => {
    origConsole[lvl](...args);
    if (LOG_TO_WA) pushLog(lvl, format(...args));
  };
}

function chunkLines(lines, max) {
  const out = [];
  let cur = '';
  for (let l of lines) {
    if (l.length > max) l = l.slice(0, max - 20) + '…[cortado]';
    if (cur && cur.length + l.length + 1 > max) { out.push(cur); cur = l; }
    else cur = cur ? cur + '\n' + l : l;
  }
  if (cur) out.push(cur);
  return out;
}

async function flushLogs() {
  if (flushing || pauseFlush || !activeSock || !logQueue.length) return;
  const now = Date.now();
  while (sendTimes.length && now - sendTimes[0] > 60_000) sendTimes.shift();
  if (sendTimes.length >= MAX_LOG_MSGS_PER_MIN) return; // espera esfriar (a fila continua acumulando)
  flushing = true;
  const sock = activeSock;
  try {
    const lines = logQueue.splice(0);
    if (droppedLines) { lines.unshift(`… ${droppedLines} linha(s) descartada(s) (fila cheia)`); droppedLines = 0; }
    const chunks = chunkLines(lines, CHUNK);
    const me = jidNormalizedUser(sock.user.id);
    for (const c of chunks.slice(0, 4)) {
      sendTimes.push(Date.now());
      const sent = await sock.sendMessage(me, { text: `${LOG_MARK} \`\`\`${c}\`\`\`` });
      rememberSent(sent);
      await delay(600);
    }
    if (chunks.length > 4) droppedLines += chunks.length - 4;
  } catch (e) {
    origConsole.error('[forwarder] falha ao mandar logs pro WhatsApp:', e?.message || e); // só no console, sem re-encaminhar
  } finally {
    flushing = false;
  }
}
setInterval(() => flushLogs().catch(() => {}), 2500).unref();

process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.stack || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.stack || e));

/* ═════════ 2. logger do Baileys (captura erros e o XML) ═════════ */
// O Baileys só gera o XML quando logger.level === 'trace', então declaramos 'trace'
// e filtramos aqui: só mostramos XML das mensagens de teste (ids em watchIds).
const watchIds = new Set();

function safe(v, max = 1200) {
  const seen = new WeakSet();
  let s;
  try {
    s = JSON.stringify(v, (_k, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (val instanceof Error) {
        return { name: val.name, message: val.message, status: val.output?.statusCode, data: val.data, stack: val.stack?.split('\n').slice(0, 4).join(' | ') };
      }
      if (val instanceof Uint8Array) return `<${val.length} bytes>`;
      if (val?.type === 'Buffer' && Array.isArray(val.data)) return `<${val.data.length} bytes>`;
      if (val && typeof val === 'object') { if (seen.has(val)) return '[circular]'; seen.add(val); }
      return val;
    });
  } catch { s = String(v); }
  return s && s.length > max ? s.slice(0, max) + '…' : s;
}

/** tira o hex gigante do <enc> pra o <biz> não ser cortado (ele fica no FIM do stanza) */
function compactXml(xml, max = 2200) {
  let s = String(xml)
    .replace(/^([ \t]*)([0-9a-f]{48,})[ \t]*$/gim, (_m, ind, hex) => `${ind}‹${hex.length >> 1} bytes›`)
    .replace(/^\t+/gm, (t) => '  '.repeat(Math.max(1, t.length >> 1)))
    .replace(/<([\w:-]+) >/g, '<$1>');
  if (s.length > max) s = s.slice(0, max >> 1) + '\n…[cortado]…\n' + s.slice(-(max >> 1));
  return s;
}

const LEVEL_RANK = { error: 0, warn: 1, info: 2 };
function fromBaileys(level, obj, msg) {
  if (LEVEL_RANK[level] > LEVEL_RANK[BAILEYS_LOG]) return;
  let body;
  if (obj instanceof Error) body = obj.stack || obj.message;
  else if (typeof obj === 'string') body = obj;
  else if (obj !== undefined) body = safe(obj);
  const text = [msg, body].filter(Boolean).join(' ');
  console[level === 'info' ? 'log' : level](`[baileys] ${text}`);
}

function makeLogger() {
  const lg = {
    level: 'trace',
    child: () => lg,
    trace(obj) {
      const xml = obj?.xml;
      if (typeof xml !== 'string' || !watchIds.size) return;
      for (const id of watchIds) {
        if (xml.includes(id)) {
          console.log(`XML ${obj.msg === 'xml send' ? '⬆ ENVIADO' : '⬇ RECEBIDO'}:\n${compactXml(xml)}`);
          return;
        }
      }
    },
    debug() {},
    info: (o, m) => fromBaileys('info', o, m),
    warn: (o, m) => fromBaileys('warn', o, m),
    error: (o, m) => fromBaileys('error', o, m),
  };
  return lg;
}

/* ═════════ 3. mensagens: cache p/ retry, texto, botões ═════════ */
const sentCache = new Map(); // id → message (o Baileys pede via getMessage quando o celular pede reenvio)
function rememberSent(msg) {
  const id = msg?.key?.id;
  if (!id || !msg.message) return;
  sentCache.set(id, msg.message);
  if (sentCache.size > 500) sentCache.delete(sentCache.keys().next().value);
}

async function sendText(sock, jid, text, quoted) {
  const sent = await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
  rememberSent(sent);
  return sent;
}

const btn = (name, params) => ({ name, buttonParamsJson: JSON.stringify(params) });
const quickReply = (text, id = text) => btn('quick_reply', { display_text: String(text), id: String(id) });

/** nós que o Baileys não anexa sozinho e que o app mobile exige */
function buildNodes({ isGroup, bot }) {
  const nodes = [{
    tag: 'biz',
    attrs: {},
    content: [{
      tag: 'interactive',
      attrs: { type: 'native_flow', v: '1' },
      content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
    }],
  }];
  if (bot && !isGroup) nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  return nodes;
}

/**
 * opts.bot (true)       anexa <bot biz_bot="1"/> em chat privado
 * opts.viewOnce (false) embrulha em viewOnceMessage
 * opts.nodes (true)     false = NÃO anexa <biz> (grupo de controle)
 */
async function sendInteractive(sock, jid, content, opts = {}) {
  const { body, footer, header, buttons } = content || {};
  if (!Array.isArray(buttons) || !buttons.length) throw new Error('sendInteractive: "buttons" precisa ser array não vazio');
  const { bot = true, viewOnce = false, nodes = true, quoted } = opts;

  const interactiveMessage = {
    body: { text: String(body ?? '') },
    ...(footer ? { footer: { text: String(footer) } } : {}),
    ...(header ? { header: { title: String(header), hasMediaAttachment: false } } : {}),
    nativeFlowMessage: { buttons, messageParamsJson: '' },
  };
  const inner = {
    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
    interactiveMessage,
  };

  const id = generateMessageIDV2(sock.user?.id);
  watchIds.add(id); // registra ANTES de enviar, pra capturar o XML de saída
  setTimeout(() => watchIds.delete(id), 120_000).unref();

  const msg = generateWAMessageFromContent(
    jid,
    viewOnce ? { viewOnceMessage: { message: inner } } : inner,
    { userJid: sock.user.id, messageId: id, quoted },
  );
  const additionalNodes = nodes ? buildNodes({ isGroup: isJidGroup(jid), bot }) : [];
  rememberSent(msg);
  await sock.relayMessage(jid, msg.message, { messageId: id, additionalNodes });
  return msg;
}

const getText = (c) =>
  c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || '';

function getInteractiveReply(c) {
  const nf = c.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (!nf?.paramsJson) return null;
  try { return JSON.parse(nf.paramsJson); } catch { return { raw: nf.paramsJson }; }
}

/* ═════════ 4. comandos ═════════ */
const VARIANTS = [
  { key: '0', label: 'CONTROLE sem <biz> (esperado: só na Web)', opts: { nodes: false } },
  { key: 'A', label: 'biz + bot (padrão)', opts: {} },
  { key: 'B', label: 'biz sem bot', opts: { bot: false } },
  { key: 'C', label: 'viewOnce + biz + bot', opts: { viewOnce: true } },
  { key: 'D', label: 'viewOnce + biz sem bot', opts: { viewOnce: true, bot: false } },
];

async function onMessage(sock, m) {
  if (!m?.message || !m.key?.remoteJid) return;
  const jid = m.key.remoteJid;
  if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  if (m.key.id && sentCache.has(m.key.id)) return; // eco do que o próprio bot mandou
  const ts = Number(m.messageTimestamp);
  if (ts && Date.now() / 1000 - ts > 90) return; // ignora mensagem velha (fila offline)

  const content = normalizeMessageContent(m.message) || {};
  const text = getText(content).trim();
  if (text.startsWith(LOG_MARK)) return; // log nosso: não processa nem loga (evita loop)

  if (content.interactiveResponseMessage) {
    const click = getInteractiveReply(content);
    console.log('🔘 CLIQUE recebido:', safe(click));
    await sendText(sock, jid, `✅ clique recebido! id=${click?.id ?? '(sem id)'}`, m);
    return;
  }

  if (!text.startsWith(PREFIX)) return;
  const [cmd, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
  console.log(`comando ${PREFIX}${cmd} de ${jid}`);

  switch ((cmd || '').toLowerCase()) {
    case 'ping':
      await sendText(sock, jid, 'pong 🏓', m);
      break;

    case 'help':
    case 'menu':
      await sendText(sock, jid, `*Comandos*\n${PREFIX}testbutton — 5 variações de botão\n${PREFIX}testbutton A — só a variação A (0, A, B, C ou D)\n${PREFIX}ping`, m);
      break;

    case 'testbutton': {
      const only = (args[0] || '').toUpperCase();
      const list = only ? VARIANTS.filter((v) => v.key === only) : VARIANTS;
      if (!list.length) { await sendText(sock, jid, `variação "${only}" não existe. Use: ${VARIANTS.map((v) => v.key).join(', ')}`, m); break; }
      pauseFlush = true; // segura os logs até terminar, pra não misturar com os testes
      try {
        await sendText(sock, jid, `Enviando ${list.length} teste(s). Olhe no *celular* (iPhone e Android) e veja quais vieram COM botão.`, m);
        for (const v of list) {
          try {
            const sent = await sendInteractive(
              sock, jid,
              { body: `Teste ${v.key}: ${v.label}`, footer: 'bao?', buttons: [quickReply(`clique ${v.key}`, v.key)] },
              v.opts,
            );
            console.log(`→ variação ${v.key} enviada (${v.label}) id=${sent.key.id}`);
          } catch (e) {
            console.error(`✗ variação ${v.key} FALHOU:`, e?.stack || e);
          }
          await delay(2000);
        }
        await delay(4000); // tempo pros acks/receipts chegarem e entrarem nos logs
        console.log('fim do ?testbutton — logs+XML logo abaixo');
      } finally {
        pauseFlush = false;
        setTimeout(() => flushLogs().catch(() => {}), 300);
      }
      break;
    }
    default:
      break;
  }
}

/* ═════════ 5. conexão + pairing code ═════════ */
async function getPairNumber() {
  if (pairNumber) return pairNumber;
  origConsole.log('Digite o número do bot com DDI+DDD+9 (só dígitos, ex: 5562999999999) e dê Enter:');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question('> ', { signal: AbortSignal.timeout(180_000) });
    pairNumber = ans.replace(/\D/g, '');
  } finally { rl.close(); }
  if (pairNumber.length < 10 || pairNumber.length > 15) { pairNumber = ''; throw new Error('número inválido'); }
  return pairNumber;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { version = (await fetchLatestBaileysVersion()).version; }
  catch (e) { console.warn('não consegui buscar a versão mais recente do WA, usando a padrão:', e?.message); }

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
  sock.ev.on('creds.update', saveCreds);

  // Watchdog: se a hospedagem bloqueia saída/DNS, o Baileys pode ficar mudo (e o processo sair
  // sem aviso). Sem 'qr' (pareando) nem 'open' (já logado) dentro do prazo, avisa e reinicia.
  let reached = false;
  let closedSeen = false;
  const watchdog = setTimeout(() => {
    if (reached) return;
    console.error(`⏱ ${WATCHDOG_MS / 1000}s sem conseguir falar com o WhatsApp (hospedagem bloqueando saída? DNS? firewall?). Tentando de novo…`);
    try { sock.end(new Error('watchdog: sem conexão')); } catch (e) { console.error('sock.end falhou:', e?.message); }
    setTimeout(() => { if (!closedSeen) boot(); }, 5000); // garante o retry mesmo se o 'close' nunca vier
  }, WATCHDOG_MS);

  let pairingRequested = false;
  const askPairing = async () => {
    if (pairingRequested || closedSeen || sock.authState.creds.registered) return;
    pairingRequested = true;
    try {
      const number = await getPairNumber();
      const code = await sock.requestPairingCode(number, PAIR_CODE);
      const pretty = code.match(/.{1,4}/g).join('-');
      origConsole.log(`\n╔══════════════════════════════════════════╗\n   CÓDIGO DE PAREAMENTO:  ${pretty}\n   WhatsApp › Aparelhos conectados › Conectar\n   aparelho › Conectar com número de telefone\n╚══════════════════════════════════════════╝\n`);
    } catch (e) {
      pairingRequested = false; // deixa tentar de novo no próximo evento
      const short = String(e?.stack || e).split('\n').slice(0, 3).join(' | ');
      console.error(`falha ao pedir o pairing code${pairNumber ? '' : ' (sem número: defina PAIR_NUMBER)'}: ${short}`);
    }
  };
  if (!sock.authState.creds.registered) setTimeout(askPairing, 8000).unref();

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr || connection === 'open') { reached = true; clearTimeout(watchdog); }
    if (qr) askPairing();
    if (connection) console.log(`connection.update → ${connection}`);

    if (connection === 'open') {
      setActiveSock(sock);
      console.log(`✅ Conectado como ${sock.user?.id}${sock.user?.lid ? ` (lid ${sock.user.lid})` : ''}`);
      console.log(`Mande ${PREFIX}testbutton pra este número (ou pra você mesmo, em "Conversar comigo").`);
      setTimeout(() => flushLogs().catch(() => {}), 1500);
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
      try { await onMessage(sock, m); }
      catch (e) { console.error('erro no handler de mensagem:', e?.stack || e); }
    }
  });
}

function boot() {
  start().catch((e) => {
    console.error('erro ao iniciar:', e?.stack || e);
    setTimeout(boot, 5000);
  });
}

if (process.env.PORT) {
  http.createServer((_q, r) => r.end('bot ok')).listen(process.env.PORT, () => origConsole.log(`http na porta ${process.env.PORT}`));
}

if (!process.env.BOT_NO_START) boot();

// exportado só pra testes offline
export { start, onMessage, sendInteractive, quickReply, buildNodes, compactXml, chunkLines, makeLogger, flushLogs, setActiveSock, logQueue, watchIds, sentCache, VARIANTS, getInteractiveReply, safe };
