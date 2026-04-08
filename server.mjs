import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { EdgeTTS } from "node-edge-tts";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const MAX_TEXT_LENGTH = Number.parseInt(process.env.MAX_TEXT_LENGTH || "5000", 10);
const TTS_RATE = process.env.TTS_RATE || "+0%";
const TTS_VOLUME = process.env.TTS_VOLUME || "+0%";
const TTS_PITCH = process.env.TTS_PITCH || "+0Hz";
const API_KEY = String(process.env.TTS_API_KEY || "").trim();

const DEFAULT_VOICES = [
  {
    id: "sofia",
    name: "Sofia",
    description: "Feminina brasileira, natural e suave",
    locale: "pt-BR",
    gender: "female",
    edge_voice: "pt-BR-FranciscaNeural"
  },
  {
    id: "caio",
    name: "Caio",
    description: "Masculina brasileira, clara e profissional",
    locale: "pt-BR",
    gender: "male",
    edge_voice: "pt-BR-AntonioNeural"
  }
];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization, x-api-key",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function parseVoicesFromEnv() {
  const raw = String(process.env.AVAILABLE_VOICES_JSON || "").trim();
  if (!raw) return DEFAULT_VOICES;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_VOICES;

    const voices = parsed
      .map((voice) => ({
        id: String(voice?.id || "").trim(),
        name: String(voice?.name || voice?.id || "").trim(),
        description: String(voice?.description || "Voz gratuita").trim(),
        locale: String(voice?.locale || "pt-BR").trim(),
        gender: typeof voice?.gender === "string" ? voice.gender : undefined,
        edge_voice: String(voice?.edge_voice || voice?.edgeVoice || "").trim()
      }))
      .filter((voice) => voice.id && voice.name && voice.edge_voice);

    return voices.length > 0 ? voices : DEFAULT_VOICES;
  } catch (error) {
    console.warn("[render-tts-multivoz] AVAILABLE_VOICES_JSON invalido:", error);
    return DEFAULT_VOICES;
  }
}

function publicVoiceShape(voice) {
  return {
    id: voice.id,
    name: voice.name,
    description: voice.description,
    locale: voice.locale,
    gender: voice.gender,
    provider: "custom"
  };
}

function getVoiceCatalog() {
  return parseVoicesFromEnv();
}

function findVoiceById(voiceId) {
  const catalog = getVoiceCatalog();
  const cleanVoiceId = String(voiceId || "").trim();
  return catalog.find((voice) => voice.id === cleanVoiceId) || null;
}

function isAuthorized(req) {
  if (!API_KEY) return true;
  const authHeader = String(req.headers.authorization || "");
  const apiKeyHeader = String(req.headers["x-api-key"] || "");
  if (apiKeyHeader && apiKeyHeader === API_KEY) return true;
  if (authHeader.startsWith("Bearer ") && authHeader.slice("Bearer ".length) === API_KEY) return true;
  return false;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

async function synthesizeToBuffer({ text, edgeVoice }) {
  const tempFilePath = path.join(os.tmpdir(), `tts-${crypto.randomUUID()}.mp3`);
  const tts = new EdgeTTS({
    voice: edgeVoice,
    rate: TTS_RATE,
    volume: TTS_VOLUME,
    pitch: TTS_PITCH
  });

  try {
    await tts.ttsPromise(text, tempFilePath);
    return await fs.readFile(tempFilePath);
  } finally {
    await fs.unlink(tempFilePath).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "invalid_request" });
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      service: "render-tts-multivoz",
      default_voice_id: getVoiceCatalog()[0]?.id || "sofia",
      voices: getVoiceCatalog().map(publicVoiceShape)
    });
    return;
  }

  if (url.pathname === "/voices" && req.method === "GET") {
    sendJson(res, 200, {
      provider: "custom",
      default_voice_id: getVoiceCatalog()[0]?.id || "sofia",
      voices: getVoiceCatalog().map(publicVoiceShape)
    });
    return;
  }

  if (url.pathname === "/tts" && req.method === "POST") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const text = String(body?.text || "").trim();
      const requestedVoiceId = String(body?.voice_id || getVoiceCatalog()[0]?.id || "sofia").trim();

      if (!text) {
        sendJson(res, 400, { error: "text_required" });
        return;
      }

      const safeText = text.slice(0, MAX_TEXT_LENGTH);
      const selectedVoice = findVoiceById(requestedVoiceId);
      const edgeVoice = selectedVoice?.edge_voice || requestedVoiceId;

      const audioBuffer = await synthesizeToBuffer({
        text: safeText,
        edgeVoice
      });

      res.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audioBuffer.byteLength)
      });
      res.end(audioBuffer);
      return;
    } catch (error) {
      console.error("[render-tts-multivoz] synthesis error:", error);
      sendJson(res, 500, {
        error: "tts_failed",
        message: error instanceof Error ? error.message : "Falha ao gerar audio"
      });
      return;
    }
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, () => {
  console.log(`[render-tts-multivoz] online na porta ${PORT}`);
});

