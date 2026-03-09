# Conversagent 🗣️🤖

> A real-time, speech-to-speech voice agent — speak naturally, hear your chosen AI speak back.

Forked from [ianb-cerebras/stagehand-voicebrowser](https://github.com/ianb-cerebras/stagehand-voicebrowser) and repurposed as a fully conversational agent. Supports **Anthropic Claude** and **Google Gemini** as the LLM, switchable via a single environment variable. Speech-to-text and text-to-speech are both powered by **Cartesia**.

---

## ✨ How it works

```
Microphone → Cartesia STT (ink-whisper, streaming)
           → Claude or Gemini (streaming tokens, your choice)
           → Cartesia TTS (sonic-3, streaming audio)
           → Speakers (via ffplay)
```

- **Streaming STT** — Cartesia Ink Whisper transcribes your speech in real time via WebSocket
- **Pluggable LLM** — Switch between Anthropic Claude and Google Gemini with `LLM_PROVIDER` in your `.env`
- **Streaming TTS** — LLM response tokens are piped directly into Cartesia TTS as they arrive, so playback starts before the model finishes generating
- **Mic gating** — The microphone pauses while the agent is speaking to prevent feedback loops
- **Multi-turn memory** — Full conversation history is maintained across the session

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

---

## ⚙️ Configuration

All configuration lives in your `.env` file:

```bash
# Required for both STT and TTS
CARTESIA_API_KEY=your_cartesia_key        # https://play.cartesia.ai/keys

# Choose your LLM provider: "anthropic" (default) or "google"
LLM_PROVIDER=anthropic

# Required if LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_key      # https://console.anthropic.com/
# ANTHROPIC_MODEL=claude-sonnet-4-5-20250929   # optional override

# Required if LLM_PROVIDER=google
GOOGLE_API_KEY=your_google_key            # https://aistudio.google.com/app/apikey
# GOOGLE_MODEL=gemini-1.5-flash               # optional override
```

### Switching providers

To use Google Gemini instead of Claude, just change one line in your `.env`:
```
LLM_PROVIDER=google
```

---

## ▶️ Running

```bash
npm start
```

Output:
```
🗣️  Conversagent — Claude Voice Agent
LLM: Anthropic Claude (claude-sonnet-4-5-20250929) · STT/TTS: Cartesia

🎤 Listening... (Ctrl+C to exit)
```

Speak naturally. The agent responds in your speakers. The conversation is multi-turn — context is retained for the full session.

---

## 🎙️ Voice commands

| Say | Result |
|-----|--------|
| Anything | Agent responds conversationally |
| "exit" / "quit" / "stop" / "goodbye" | Shuts down gracefully |

---

## 🧱 Project structure

```
index.ts          ← Main agent loop (STT → LLM → TTS)
package.json      ← Dependencies
.env.example      ← API key + config template
```
