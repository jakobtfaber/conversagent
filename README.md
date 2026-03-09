# Conversagent 🗣️🤖

> A real-time, speech-to-speech Claude voice agent — speak naturally, hear Claude speak back.

Forked from [ianb-cerebras/stagehand-voicebrowser](https://github.com/ianb-cerebras/stagehand-voicebrowser) and repurposed as a fully conversational agent powered by **Anthropic Claude** and **Cartesia** for both speech-to-text and text-to-speech.

---

## ✨ How it works

```
Microphone → Cartesia STT (ink-whisper, streaming)
           → Claude API (claude-sonnet, streaming tokens)
           → Cartesia TTS (sonic-3, streaming audio)
           → Speakers (via ffplay)
```

- **Streaming STT** — Cartesia's Ink Whisper model transcribes your speech in real time via WebSocket
- **Claude agent** — Each transcript is sent to Claude with full conversation history for multi-turn memory
- **Streaming TTS** — Claude's response tokens are piped directly into Cartesia's TTS WebSocket as they arrive, so playback starts before Claude finishes generating
- **Mic gating** — The microphone pauses while Claude is speaking to prevent feedback loops

---

## 🔧 Requirements

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 18 | |
| FFmpeg / SoX | any | Audio capture (`rec`) and playback (`ffplay`) |

---

## 🏗️ Setup

```bash
# 1. Clone and install
git clone https://github.com/jakobtfaber/conversagent.git
cd conversagent
pnpm install   # or: npm install

# 2. Install FFmpeg if missing (macOS)
brew install ffmpeg

# 3. Configure API keys
cp .env.example .env
# Edit .env and fill in your keys
```

**`.env`**
```
CARTESIA_API_KEY=your_cartesia_key     # https://play.cartesia.ai/keys
ANTHROPIC_API_KEY=your_anthropic_key   # https://console.anthropic.com/
```

---

## ▶️ Running

```bash
npm start
```

The agent will print:
```
🗣️  Conversagent — Claude Voice Agent
Powered by Anthropic Claude + Cartesia STT/TTS

🎤 Listening... (Ctrl+C to exit)
```

Speak naturally. Claude will respond in your speakers. The conversation is multi-turn — Claude remembers everything said in the session.

---

## 🎙️ Voice commands

| Say | Result |
|-----|--------|
| Anything | Claude responds conversationally |
| "exit" / "quit" / "stop" / "goodbye" | Shuts down gracefully |

---

## ⚙️ Configuration

Edit the constants at the top of `index.ts` to customize:

| Constant | Default | Description |
|----------|---------|-------------|
| `VOICE_ID` | `6ccbfb76-...` | Cartesia voice ID — browse at [play.cartesia.ai/voices](https://play.cartesia.ai/voices) |
| `TTS_MODEL` | `sonic-3` | Cartesia TTS model |
| `STT_MODEL` | `ink-whisper` | Cartesia STT model |
| `CLAUDE_MODEL` | `claude-sonnet-4-5-20250929` | Anthropic model |

---

## 🧱 Project structure

```
index.ts          ← Main agent loop (STT → Claude → TTS)
package.json      ← Dependencies
.env.example      ← API key template
```
