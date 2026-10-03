/**
 * bot.mjs - bot Baileys Completo (Listas, YT Downloader, Stickers Animados, Live Photo)
 * 
 * Rodar:  node bot.mjs      (Node >= 20)
 * Env:
 *   PAIR_CODE     pairing code customizado, exatamente 8 chars
 *   PREFIX        prefixo dos comandos (padrao: ?)
 *   AUTH_DIR      pasta da sessao (padrao: ./auth)
 *   PORT          porta http de health check
 *   BAILEYS_LOG   error | warn | info (padrao: warn)
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
} from '@whiskeysockets/baileys';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

/* ============================ config ============================ */
const PREFIX = process.env.PREFIX || '?';
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const PAIR_CODE = (process.env.PAIR_CODE || '').toUpperCase() || undefined;
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS) || 60_000;
const ENABLE_EVAL = process.env.ENABLE_EVAL === 'true';
const OWNER_JIDS = new Set((process.env.OWNER_JIDS || '').split(',').map((j) => j.trim()).filter(Boolean));

const PAIR_NUMBER = '5562996664760';

/* ============================ pasta temporaria ============================ */
const TMP_DIR = './tmp';
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

/* ============================ estado ============================ */
let activeSock = null;
const setActiveSock = (s) => { activeSock = s; };

const sentCache = new Map();
const messageStore = new Map();
const ytSessions = new Map(); // Controle de sessoes do YouTube por JID_Sender

function rememberSent(msg) {
  const id = msg?.key?.id;
  if (!id || !msg.message) return;
  sentCache.set(id, msg.message);
  if (sentCache.size > 500) sentCache.delete(sentCache.keys().next().value);
}

function storeMessage(message) {
  if (!message?.key?.id) return;
  messageStore.set(message.key.id, message);
  if (messageStore.size > 1000) messageStore.delete(messageStore.keys().next().value);
}

/* ==================== emojis ascii ==================== */
const E = {
  camera:  '\u{1F4F8}', police:  '\u{1F46E}', tools:   '\u{1F6E0}\u{FE0F}',
  info:    '\u{2139}\u{FE0F}', picture: '\u{1F5BC}\u{FE0F}', robot:   '\u{1F916}',
  users:   '\u{1F465}', bolt:    '\u{26A1}', trash:   '\u{1F5D1}\u{FE0F}',
  up:      '\u{2B06}\u{FE0F}', down:    '\u{2B07}\u{FE0F}', point:   '\u{261D}\u{FE0F}',
  x:       '\u{274C}', ping:    '\u{1F3D3}', clock:   '\u{23F1}\u{FE0F}',
  lock:    '\u{1F510}', no:      '\u{26D4}', ok:      '\u{2705}',
  music:   '\u{1F3B5}', play:    '\u{25B6}\u{FE0F}', film:    '\u{1F3AC}',
  warning: '\u{26A0}\u{FE0F}', loading: '\u{23F3}',
};

/* ==================== logger e utilitarios ==================== */
function makeLogger() {
  const emit = (lvl, a, b) => {
    if (lvl === 'trace' || lvl === 'debug') return;
    const msg = a instanceof Error ? a.stack : String(a);
    console.log(`[baileys] ${b || ''} ${msg}`.trim());
  };
  return { level: 'trace', child: () => makeLogger(), trace: (o, m) => emit('trace', o, m), debug: (o, m) => emit('debug', o, m), info: (o, m) => emit('info', o, m), warn: (o, m) => emit('warn', o, m), error: (o, m) => emit('error', o, m) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeJid = (jid) => String(jid || '').replace(/:.*/, '').trim().toLowerCase();
const isGroup = (jid) => jid?.endsWith('@g.us') ?? false;
const isOwner = (jid) => OWNER_JIDS.has(normalizeJid(jid));

function unwrap(message) {
  let content = message?.message;
  while (content) {
    const wrapper = content.ephemeralMessage || content.viewOnceMessage || content.viewOnceMessageV2 || content.documentWithCaptionMessage;
    if (!wrapper?.message) break;
    content = wrapper.message;
  }
  return content || {};
}

function textOf(message) {
  const c = unwrap(message);
  return (c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || c.documentMessage?.caption || '').trim();
}

function senderOf(message) { return message.key.participant || message.key.remoteJid || ''; }

async function reply(sock, jid, message, content) {
  const sent = await sock.sendMessage(jid, content, { quoted: message });
  rememberSent(sent);
  return sent;
}

/* ==================== importacao preguicosa (lazy) ==================== */
let libs = {};
async function loadLibs() {
  if (libs.sharp) return libs;
  try {
    libs.sharp = (await import('sharp')).default;
    libs.ffmpeg = (await import('fluent-ffmpeg')).default;
    libs.yts = (await import('yt-search')).default;
    libs.ytdl = (await import('@distube/ytdl-core')).default;
  } catch (e) {
    console.error('Falta dependencia! Rode: npm i sharp fluent-ffmpeg yt-search @distube/ytdl-core');
    console.error(e.message);
  }
  return libs;
}

/* ==================== download helper ==================== */
async function downloadMedia(mediaMessage, mediaType) {
  const stream = await downloadContentFromMessage(mediaMessage, mediaType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const getTempFile = (ext) => path.join(TMP_DIR, `${crypto.randomBytes(6).toString('hex')}.${ext}`);

/* ==================== LISTAS (NOVO MENU) ==================== */
const MENU_TEXTOS = {
  'menu_fig': '*' + E.picture + ' MENU FIGURAS*\n\n' + PREFIX + 's - Cria figurinha (img/gif/video)\n' + PREFIX + 'tolivep - Cria Live Photo (video/gif)\n' + PREFIX + 'img - Figurinha para Imagem',
  'menu_mod': '*' + E.police + ' MENU MODERA\u00C7\u00C3O*\n\n' + PREFIX + 'ban @user\n' + PREFIX + 'promote @user\n' + PREFIX + 'demote @user',
  'menu_util': '*' + E.tools + ' MENU UTILIT\u00C1RIOS*\n\n' + PREFIX + 'ping\n' + PREFIX + 'uptime\n' + PREFIX + 'info',
  'menu_yt': '*' + E.play + ' MENU YOUTUBE*\n\n' + PREFIX + 'play <nome> - Busca e baixa musicas ou videos do YouTube',
};

async function sendListMenu(sock, jid, message) {
  const sections = [{
    title: 'Escolha uma categoria',
    rows: [
      { title: E.camera + ' Figuras / M\u00EDdia', rowId: 'cmd_menu_fig', description: 'Stickers e Live Photos' },
      { title: E.play + ' YouTube', rowId: 'cmd_menu_yt', description: 'Baixar audios e videos' },
      { title: E.police + ' Modera\u00E7\u00E3o', rowId: 'cmd_menu_mod', description: 'Apenas Admins' },
      { title: E.tools + ' Utilit\u00E1rios', rowId: 'cmd_menu_util', description: 'Ping, info, etc' },
    ]
  }];

  await sock.sendMessage(jid, {
    text: '*' + E.robot + ' SyntraxBot - Menu Principal*\nSelecione uma opcao abaixo:',
    footer: 'SyntraxBot v1.2',
    buttonText: 'ABRIR MENU',
    sections
  }, { quoted: message });
}

/* ==================== COMANDOS DE M\u00CDDIA (STICKER / LIVE PHOTO) ==================== */
async function handleSticker(sock, jid, message) {
  const content = unwrap(message);
  const isImage = !!content.imageMessage;
  const isVideo = !!content.videoMessage;
  const media = content.imageMessage || content.videoMessage;

  if (!media) return reply(sock, jid, message, { text: 'Responda uma imagem, GIF ou v\u00EDdeo curto com ' + PREFIX + 's' });

  const { sharp, ffmpeg } = await loadLibs();
  if (!sharp || !ffmpeg) return reply(sock, jid, message, { text: 'Faltam bibliotecas no servidor.' });

  try {
    const buf = await downloadMedia(media, isImage ? 'image' : 'video');
    
    if (isImage) {
      const webp = await sharp(buf).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp().toBuffer();
      return reply(sock, jid, message, { sticker: webp });
    } else {
      // Video ou GIF animado -> Sticker Animado
      if (media.seconds > 10) return reply(sock, jid, message, { text: 'O v\u00EDdeo deve ter menos de 10 segundos.' });
      
      const inFile = getTempFile('mp4');
      const outFile = getTempFile('webp');
      fs.writeFileSync(inFile, buf);

      await new Promise((resolve, reject) => {
        ffmpeg(inFile)
          .inputOptions(['-t', '10'])
          .complexFilter(['scale=512:512:flags=lanczos:force_original_aspect_ratio=decrease', 'format=rgba', 'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000'])
          .outputOptions(['-vcodec', 'libwebp', '-lossless', '0', '-qscale', '50', '-loop', '0', '-preset', 'default', '-an', '-vsync', '0'])
          .save(outFile).on('end', resolve).on('error', reject);
      });

      await reply(sock, jid, message, { sticker: fs.readFileSync(outFile) });
      fs.unlinkSync(inFile); fs.unlinkSync(outFile);
    }
  } catch (error) {
    console.error('Erro no sticker:', error);
    reply(sock, jid, message, { text: E.x + ' Falha ao criar sticker.' });
  }
}

async function handleLivePhoto(sock, jid, message) {
  const content = unwrap(message);
  const media = content.videoMessage;
  if (!media) return reply(sock, jid, message, { text: 'Responda um v\u00EDdeo ou GIF com ' + PREFIX + 'tolivep' });
  if (media.seconds > 60) return reply(sock, jid, message, { text: 'O v\u00EDdeo deve ter no m\u00E1ximo 60 segundos.' });

  const { ffmpeg } = await loadLibs();
  if (!ffmpeg) return;

  try {
    const buf = await downloadMedia(media, 'video');
    const inFile = getTempFile('mp4');
    const outFile = getTempFile('mp4');
    fs.writeFileSync(inFile, buf);

    await new Promise((resolve, reject) => {
      // Live photo (Video Note) exige ser quadrado (1:1)
      ffmpeg(inFile)
        .complexFilter(['scale=400:400:force_original_aspect_ratio=increase', 'crop=400:400'])
        .outputOptions(['-c:v', 'libx264', '-crf', '28', '-preset', 'superfast', '-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p'])
        .save(outFile).on('end', resolve).on('error', reject);
    });

    // PTV: true define que e uma Live Photo / Video Note
    await sock.sendMessage(jid, { video: fs.readFileSync(outFile), ptv: true }, { quoted: message });
    fs.unlinkSync(inFile); fs.unlinkSync(outFile);
  } catch (error) {
    console.error('Erro no tolivep:', error);
    reply(sock, jid, message, { text: E.x + ' Falha ao processar live photo.' });
  }
}

/* ==================== YOUTUBE DOWNLOADER & FILA ==================== */
const ytQueue = [];
let isProcessingYt = false;

async function processYtQueue(sock) {
  if (isProcessingYt || ytQueue.length === 0) return;
  isProcessingYt = true;
  const task = ytQueue.shift();
  try {
    await task.execute(sock);
  } catch (err) {
    console.error('Erro na fila do YT:', err);
    await sock.sendMessage(task.jid, { text: E.x + ' Erro ao processar seu download.' });
  } finally {
    isProcessingYt = false;
    processYtQueue(sock);
  }
}

async function handleYtSearch(sock, jid, sender, query, message) {
  if (!query) return reply(sock, jid, message, { text: 'Use: ' + PREFIX + 'play <nome da musica>' });
  
  const { yts } = await loadLibs();
  if (!yts) return reply(sock, jid, message, { text: 'M\u00F3dulo YouTube n\u00E3o carregado.' });

  await reply(sock, jid, message, { text: E.loading + ' Buscando no YouTube...' });
  
  try {
    const results = await yts(query);
    const videos = results.videos.slice(0, 5);
    if (!videos.length) return reply(sock, jid, message, { text: E.x + ' Nenhum resultado encontrado.' });

    // Salva a sessao do usuario
    const sessionId = jid + '_' + sender;
    ytSessions.set(sessionId, { videos, updatedAt: Date.now() });

    const rows = videos.map((v, index) => ({
      title: v.title.slice(0, 70),
      rowId: `yt_sel_${index}`,
      description: `${v.timestamp} - ${v.author.name}`.slice(0, 72)
    }));

    await sock.sendMessage(jid, {
      text: '*' + E.music + ' Resultados para:* ' + query,
      footer: 'Selecione o v\u00EDdeo abaixo',
      buttonText: 'VER RESULTADOS',
      sections: [{ title: 'M\u00FAsicas Encontradas', rows }]
    }, { quoted: message });

  } catch (e) {
    console.error(e);
    reply(sock, jid, message, { text: E.x + ' Erro na busca.' });
  }
}

async function enqueueYtDownload(sock, jid, videoInfo, format) {
  const msgInfo = await sock.sendMessage(jid, { text: E.loading + ` Colocando "${videoInfo.title}" na fila de ${format} (Posi\u00E7\u00E3o: ${ytQueue.length + 1}). Aguarde...` });
  
  ytQueue.push({
    jid,
    execute: async (s) => {
      await s.sendMessage(jid, { text: E.clock + ` Baixando ${format}: ${videoInfo.title}...` }, { edit: msgInfo.key });
      
      const { ytdl } = await loadLibs();
      
      // NOTA PARA A RAILWAY:
      // Se o IP for banido e pedir 'Sign in to confirm you are not a bot',
      // voce precisa criar um Agent com cookies no ytdl-core.
      // const agent = ytdl.createAgent([{ name: "cookie_name", value: "cookie_value" }]);
      // E passar abaixo: ytdl(url, { agent, filter: ... })
      
      const MAX_MINS = 15; // Limite de 15 min
      if (videoInfo.seconds > (MAX_MINS * 60)) {
         return s.sendMessage(jid, { text: E.no + ' O v\u00EDdeo excede o limite de ' + MAX_MINS + ' minutos.' });
      }

      const streamInfo = format === 'audio' 
        ? { filter: 'audioonly', quality: 'highestaudio' }
        : { filter: 'audioandvideo', quality: 'highest' }; // Para video as vezes 'highest' limita a 720p 30fps

      const tmpPath = getTempFile(format === 'audio' ? 'mp3' : 'mp4');
      const writeStream = fs.createWriteStream(tmpPath);
      
      return new Promise((resolve, reject) => {
        const stream = ytdl(videoInfo.url, streamInfo);
        
        let downloadedMB = 0;
        stream.on('data', (chunk) => {
          downloadedMB += chunk.length / 1024 / 1024;
          if (downloadedMB > 55) { // WA aceita max 50-64MB
            stream.destroy();
            reject(new Error('Tamanho excedeu 50MB'));
          }
        });

        stream.pipe(writeStream);
        
        writeStream.on('finish', async () => {
          try {
            if (format === 'audio') {
              await s.sendMessage(jid, { document: fs.readFileSync(tmpPath), mimetype: 'audio/mpeg', fileName: videoInfo.title + '.mp3' });
            } else {
              await s.sendMessage(jid, { video: fs.readFileSync(tmpPath), caption: videoInfo.title });
            }
            fs.unlinkSync(tmpPath);
            resolve();
          } catch (e) { reject(e); }
        });
        
        stream.on('error', reject);
        writeStream.on('error', reject);
      });
    }
  });
  
  processYtQueue(sock);
}

/* ==================== INTERCEPTADOR DE LISTAS ==================== */
async function handleListResponse(sock, jid, sender, message, rowId) {
  // Trata menus estaticos
  if (rowId.startsWith('cmd_menu_')) {
    const txt = MENU_TEXTOS[rowId.replace('cmd_', '')];
    if (txt) await sock.sendMessage(jid, { text: txt });
    return;
  }

  // Trata selecao de video do YT
  if (rowId.startsWith('yt_sel_')) {
    const idx = parseInt(rowId.replace('yt_sel_', ''));
    const sessionId = jid + '_' + sender;
    const session = ytSessions.get(sessionId);
    if (!session || !session.videos[idx]) {
      return sock.sendMessage(jid, { text: E.warning + ' Sess\u00E3o de busca expirada. Busque novamente.' });
    }
    
    const video = session.videos[idx];
    session.selectedVideo = video; // Salva escolha
    
    await sock.sendMessage(jid, {
      text: `*${video.title}*\n\nComo voc\u00EA deseja baixar?`,
      footer: 'Escolha o formato',
      buttonText: 'FORMATO',
      sections: [{
        title: 'Op\u00E7\u00F5es',
        rows: [
          { title: E.music + ' Apenas \u00C1udio', rowId: 'yt_fmt_audio', description: 'Download em MP3' },
          { title: E.film + ' V\u00EDdeo Completo', rowId: 'yt_fmt_video', description: 'Download em MP4' }
        ]
      }]
    }, { quoted: message });
    return;
  }

  // Trata selecao do formato de download (audio ou video)
  if (rowId === 'yt_fmt_audio' || rowId === 'yt_fmt_video') {
    const sessionId = jid + '_' + sender;
    const session = ytSessions.get(sessionId);
    if (!session || !session.selectedVideo) return sock.sendMessage(jid, { text: E.warning + ' Sessa\u00E3o expirada.' });
    
    const format = rowId === 'yt_fmt_audio' ? 'audio' : 'video';
    ytSessions.delete(sessionId); // limpa a sessao
    await enqueueYtDownload(sock, jid, session.selectedVideo, format);
  }
}

/* ==================== comandos de grupo/uteis originais ==================== */
async function executeCode(sock, jid, sender, code, message) {
  if (!ENABLE_EVAL) return reply(sock, jid, message, { text: E.no + ' Execucao desativada.' });
  if (!isOwner(sender)) return reply(sock, jid, message, { text: E.lock + ' Somente dono.' });
  try {
    const result = await new Function('socket', 'jid', 'sender', 'msg', 'sleep', 'return (async () => {\n' + code + '\n})()')(sock, jid, sender, message, sleep);
    const out = result === undefined ? E.ok : typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    await reply(sock, jid, message, { text: '```\n' + out.slice(0, 4000) + '\n```' });
  } catch (error) { await reply(sock, jid, message, { text: String(error).slice(0,500) }); }
}

const COMMAND_HANDLERS = {
  menu: ({ sock, jid, message }) => sendListMenu(sock, jid, message),
  help: ({ sock, jid, message }) => sendListMenu(sock, jid, message),
  ping: ({ sock, jid, message }) => reply(sock, jid, message, { text: E.ping + ' Pong!' }),
  uptime: ({ sock, jid, message }) => reply(sock, jid, message, { text: E.clock + ' Uptime: ' + Math.floor(process.uptime()) + 's' }),
  
  s:       ({ sock, jid, message }) => handleSticker(sock, jid, message),
  sticker: ({ sock, jid, message }) => handleSticker(sock, jid, message),
  fig:     ({ sock, jid, message }) => handleSticker(sock, jid, message),
  
  tolivep: ({ sock, jid, message }) => handleLivePhoto(sock, jid, message),

  play:    ({ sock, jid, sender, body, message }) => handleYtSearch(sock, jid, sender, body, message),
  yt:      ({ sock, jid, sender, body, message }) => handleYtSearch(sock, jid, sender, body, message),
  
  eval:    ({ sock, jid, sender, body, message }) => executeCode(sock, jid, sender, body, message),
};

/* ==================== handler principal ==================== */
async function onMessage(sock, m) {
  if (!m?.message || !m.key?.remoteJid) return;
  const jid = m.key.remoteJid;
  if (jid === 'status@broadcast' || jid.endsWith('@newsletter') || m.key.fromMe) return;

  storeMessage(m);
  const sender = senderOf(m);
  const content = unwrap(m);

  // Verifica se eh resposta de Lista
  const listResponseId = content.listResponseMessage?.singleSelectReply?.selectedRowId 
                      || content.buttonsResponseMessage?.selectedButtonId 
                      || content.templateButtonReplyMessage?.selectedId;

  if (listResponseId) {
    await handleListResponse(sock, jid, sender, m, listResponseId);
    return;
  }

  const text = textOf(m);
  if (!text.startsWith(PREFIX)) return;

  const parts = text.slice(PREFIX.length).trim().split(/\s+/);
  const command = (parts.shift() || '').toLowerCase();
  const args = parts;
  const body = args.join(' ');

  const handler = COMMAND_HANDLERS[command];
  if (handler) {
    try { await handler({ sock, jid, sender, message: m, args, body }); }
    catch (e) { console.error(e); }
  }
}

/* ==================== conexao + pairing code ==================== */
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try { version = (await fetchLatestBaileysVersion()).version; } catch (e) {}

  const sock = makeWASocket({
    version,
    auth: state,
    logger: makeLogger(),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    getMessage: async (key) => sentCache.get(key.id),
  });
  
  setActiveSock(sock);
  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;
  const askPairing = async () => {
    if (pairingRequested || sock.authState.creds.registered) return;
    pairingRequested = true;
    try {
      const code = await sock.requestPairingCode(PAIR_NUMBER, PAIR_CODE);
      console.log('\n\n=== CODIGO DE PAREAMENTO: ' + code.match(/.{1,4}/g).join('-') + ' ===\n\n');
    } catch (e) { console.error('erro no pairing:', e.message); }
  };
  if (!sock.authState.creds.registered) setTimeout(askPairing, 8000);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) askPairing();
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      setTimeout(boot, code === DisconnectReason.restartRequired ? 500 : 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type === 'notify') {
      for (const m of messages) await onMessage(sock, m);
    }
  });
}

function boot() {
  start().catch((e) => {
    console.error(e);
    setTimeout(boot, 5000);
  });
}

if (process.env.PORT) http.createServer((_q, r) => r.end('ok')).listen(process.env.PORT);

loadLibs().then(() => boot()); // forca load lazy antes de conectar
