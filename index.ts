// @ts-nocheck
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Cartesia from "@cartesia/cartesia-js";
import { spawn } from "child_process";
import dotenv from "dotenv";
import chalk from "chalk";
import WebSocket from "ws";

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Set LLM_PROVIDER in your .env to "anthropic" or "google" (default: anthropic)
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();

// Model names — override in .env if desired
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const GOOGLE_MODEL = process.env.GOOGLE_MODEL || "gemini-1.5-flash";

// Cartesia config
const VOICE_ID = "6ccbfb76-1fc6-48f7-b71d-91ac6298247b"; // https://play.cartesia.ai/voices
const TTS_MODEL = "sonic-3";
const STT_MODEL = "ink-whisper";

const SYSTEM_PROMPT =
  "You are a helpful voice assistant. Keep responses concise and conversational — " +
  "you are speaking aloud, so avoid bullet points, markdown, or long lists. " +
  "Aim for natural spoken language.";

// Conversation history — grows turn-by-turn for multi-turn memory
// Shape: { role: "user" | "assistant", content: string }[]
const history = [];

// ─── Audio playback via ffplay ────────────────────────────────────────────────

function spawnPlayer() {
  const player = spawn("ffplay", [
    "-f", "f32le",
    "-ar", "44100",
    "-ac", "1",
    "-nodisp",
    "-vn",
    "-loglevel", "quiet",
    "-probesize", "32",
    "-analyzeduration", "0",
    "-i", "pipe:0",
  ]);
  player.on("error", (err) => console.error(chalk.red("ffplay error:"), err));
  player.stdin.on("error", () => {}); // suppress broken pipe errors on early exit
  return player.stdin;
}

// ─── TTS: token stream → Cartesia → speaker ──────────────────────────────────

/**
 * Accepts an async iterable of text tokens, pipes them to Cartesia TTS
 * via WebSocket, and plays the resulting audio in real time.
 * Returns the full concatenated text.
 */
async function streamTokensToSpeaker(tokenStream) {
  const cartesia = new Cartesia({ apiKey: CARTESIA_API_KEY });
  const ws = await cartesia.tts.websocket();
  ws.on("error", (err) => console.error(chalk.red("Cartesia TTS WS error:"), err));

  const ctx = ws.context({
    model_id: TTS_MODEL,
    voice: { mode: "id", id: VOICE_ID },
    output_format: { container: "raw", encoding: "pcm_f32le", sample_rate: 44100 },
  });

  const playerStdin = spawnPlayer();
  let fullText = "";

  const pushTokens = async () => {
    for await (const token of tokenStream) {
      fullText += token;
      process.stdout.write(chalk.cyan(token));
      await ctx.push({ transcript: token });
    }
    await ctx.no_more_inputs();
  };

  const receiveAudio = async () => {
    for await (const event of ctx.receive()) {
      if (event.type === "chunk" && event.audio) {
        playerStdin.write(event.audio);
      }
    }
    playerStdin.end();
  };

  await Promise.all([pushTokens(), receiveAudio()]);
  ws.close();
  console.log();
  return fullText;
}

// ─── LLM providers ───────────────────────────────────────────────────────────

/**
 * Returns an async generator that yields text tokens from Anthropic Claude.
 */
async function* anthropicTokenStream(userText) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const stream = client.messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: history,
  });
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

/**
 * Returns an async generator that yields text tokens from Google Gemini.
 */
async function* googleTokenStream(userText) {
  const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({
    model: GOOGLE_MODEL,
    systemInstruction: SYSTEM_PROMPT,
  });

  // Gemini uses "model" instead of "assistant" for the role
  const geminiHistory = history.slice(0, -1).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const chat = model.startChat({ history: geminiHistory });
  const result = await chat.sendMessageStream(userText);

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) yield text;
  }
}

/**
 * Returns the appropriate token stream generator based on LLM_PROVIDER.
 */
function getLLMTokenStream(userText) {
  if (LLM_PROVIDER === "google") {
    return googleTokenStream(userText);
  }
  return anthropicTokenStream(userText);
}

// ─── STT: mic → Cartesia streaming WebSocket ─────────────────────────────────

async function loadAudioRecorder() {
  const { default: AudioRecorder } = await import("node-audiorecorder");
  return AudioRecorder;
}

async function startSTT(onTranscript) {
  const qs = new URLSearchParams({
    model: STT_MODEL,
    encoding: "pcm_s16le",
    sample_rate: "16000",
  }).toString();

  const sttWs = new WebSocket(`wss://api.cartesia.ai/stt/websocket?${qs}`, {
    headers: {
      "X-API-Key": CARTESIA_API_KEY,
      "Cartesia-Version": "2025-04-16",
    },
  });

  const AudioRecorder = await loadAudioRecorder();
  let recorder;
  let isProcessing = false;

  function startRecorder() {
    recorder = new AudioRecorder(
      {
        program: "rec",
        device: null,
        bits: 16,
        channels: 1,
        encoding: "signed-integer",
        rate: 16000,
        type: "raw",
        silence: 0,
      },
      console
    );
    recorder.start().stream().on("data", (chunk) => {
      if (sttWs.readyState === WebSocket.OPEN && !isProcessing) {
        sttWs.send(chunk, { binary: true });
      }
    });
  }

  sttWs.on("open", () => {
    console.log(chalk.yellow("\n🎤 Listening... (Ctrl+C to exit)\n"));
    startRecorder();
  });

  sttWs.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "transcript" && msg.is_final) {
      const text =
        msg.words?.map((w) => w.word).join("") || msg.text || "";
      const trimmed = text.trim();
      if (trimmed.length < 4 || isProcessing) return;

      isProcessing = true;
      recorder?.stop();
      await onTranscript(trimmed);
      isProcessing = false;
      startRecorder();
    }
  });

  sttWs.on("error", (err) => console.error(chalk.red("STT WS error:"), err));
  sttWs.on("close", () => console.log(chalk.gray("STT WebSocket closed")));

  return () => {
    recorder?.stop();
    try { sttWs.send("finalize"); sttWs.close(); } catch {}
  };
}

// ─── Main conversation loop ───────────────────────────────────────────────────

async function handleTurn(userText) {
  console.log(chalk.green(`\n👤 You: ${userText}`));
  process.stdout.write(chalk.magenta("\n🤖 Claude: "));

  // Add user message to history before calling LLM
  history.push({ role: "user", content: userText });

  const tokenStream = getLLMTokenStream(userText);
  const assistantText = await streamTokensToSpeaker(tokenStream);

  // Add assistant reply to history for next turn
  history.push({ role: "assistant", content: assistantText });
}

async function main() {
  // Validate required keys based on chosen provider
  if (!CARTESIA_API_KEY) throw new Error("CARTESIA_API_KEY not set in .env");
  if (LLM_PROVIDER === "google" && !GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY not set in .env (required when LLM_PROVIDER=google)");
  }
  if (LLM_PROVIDER === "anthropic" && !ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set in .env (required when LLM_PROVIDER=anthropic)");
  }

  const providerLabel =
    LLM_PROVIDER === "google"
      ? `Google Gemini (${GOOGLE_MODEL})`
      : `Anthropic Claude (${ANTHROPIC_MODEL})`;

  console.log(chalk.cyan("🗣️  Conversagent — Claude Voice Agent"));
  console.log(chalk.gray(`LLM: ${providerLabel} · STT/TTS: Cartesia\n`));

  const cleanup = await startSTT(async (text) => {
    const lower = text.toLowerCase().trim();
    if (["exit", "quit", "stop", "goodbye"].some((w) => lower.includes(w))) {
      console.log(chalk.green("\n👋 Goodbye!"));
      cleanup();
      process.exit(0);
    }
    await handleTurn(text);
  });

  process.on("SIGINT", () => {
    console.log(chalk.green("\n👋 Shutting down."));
    cleanup();
    process.exit(0);
  });

  process.stdin.resume();
}

main().catch((err) => {
  console.error(chalk.red("Fatal error:"), err);
  process.exit(1);
});
