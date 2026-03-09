// @ts-nocheck
import Anthropic from "@anthropic-ai/sdk";
import Cartesia from "@cartesia/cartesia-js";
import { spawn } from "child_process";
import dotenv from "dotenv";
import chalk from "chalk";
import WebSocket from "ws";

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// A pleasant, neutral Cartesia voice. Swap for any voice ID from your account.
// Browse voices at: https://play.cartesia.ai/voices
const VOICE_ID = "6ccbfb76-1fc6-48f7-b71d-91ac6298247b";
const TTS_MODEL = "sonic-3";
const STT_MODEL = "ink-whisper";
const CLAUDE_MODEL = "claude-sonnet-4-5-20250929";

// Conversation history — grows turn-by-turn for multi-turn memory
const history = [];

// ─── Audio playback via ffplay ────────────────────────────────────────────────

/**
 * Spawn ffplay to consume raw PCM f32le at 44100 Hz from stdin.
 * Returns the stdin WriteStream to pipe audio into.
 */
function spawnPlayer() {
  const player = spawn("ffplay", [
    "-f", "f32le",
    "-ar", "44100",
    "-ac", "1",
    "-nodisp",
    "-autoexit",
    "-loglevel", "quiet",
    "pipe:0",
  ]);
  player.on("error", (err) => console.error(chalk.red("ffplay error:"), err));
  return player.stdin;
}

// ─── TTS: stream Claude tokens → Cartesia → speaker ─────────────────────────

/**
 * Given a Claude streaming response, pipe each text_delta token into a
 * Cartesia TTS WebSocket context and play audio chunks in real-time.
 * Returns the full assistant text when done.
 */
async function streamTTS(claudeStream) {
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

  // Pipe Claude token stream into Cartesia TTS context as tokens arrive
  const pushTokens = async () => {
    for await (const event of claudeStream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const token = event.delta.text;
        fullText += token;
        process.stdout.write(chalk.cyan(token)); // mirror to terminal
        await ctx.push({ transcript: token });
      }
    }
    await ctx.no_more_inputs();
  };

  // Receive audio chunks from Cartesia and pipe to ffplay
  const receiveAudio = async () => {
    for await (const event of ctx.receive()) {
      if (event.type === "chunk" && event.audio) {
        playerStdin.write(event.audio);
      }
    }
    playerStdin.end();
  };

  // Run concurrently: push tokens while receiving + playing audio
  await Promise.all([pushTokens(), receiveAudio()]);
  ws.close();

  console.log(); // newline after streamed text
  return fullText;
}

// ─── STT: mic → Cartesia streaming WebSocket ─────────────────────────────────

async function loadAudioRecorder() {
  const { default: AudioRecorder } = await import("node-audiorecorder");
  return AudioRecorder;
}

/**
 * Open a Cartesia STT WebSocket and stream mic audio into it.
 * Each final transcript fires onTranscript.
 * Returns a cleanup() function.
 */
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

      // Pause mic while Claude is thinking/speaking to avoid feedback loop
      isProcessing = true;
      recorder?.stop();

      await onTranscript(trimmed);

      // Resume listening after Claude finishes responding
      isProcessing = false;
      startRecorder();
    }
  });

  sttWs.on("error", (err) => console.error(chalk.red("STT WS error:"), err));
  sttWs.on("close", () => console.log(chalk.gray("STT WebSocket closed")));

  return () => {
    recorder?.stop();
    try {
      sttWs.send("finalize");
      sttWs.close();
    } catch {}
  };
}

// ─── Main conversation loop ───────────────────────────────────────────────────

async function handleTurn(userText) {
  console.log(chalk.green(`\n👤 You: ${userText}`));
  process.stdout.write(chalk.magenta("\n🤖 Claude: "));

  history.push({ role: "user", content: userText });

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const claudeStream = anthropic.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system:
      "You are a helpful voice assistant. Keep responses concise and conversational — " +
      "you are speaking aloud, so avoid bullet points, markdown, or long lists. " +
      "Aim for natural spoken language.",
    messages: history,
  });

  const assistantText = await streamTTS(claudeStream);

  history.push({ role: "assistant", content: assistantText });
}

async function main() {
  console.log(chalk.cyan("🗣️  Conversagent — Claude Voice Agent"));
  console.log(chalk.gray("Powered by Anthropic Claude + Cartesia STT/TTS\n"));

  if (!CARTESIA_API_KEY) throw new Error("CARTESIA_API_KEY not set in .env");
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set in .env");

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
