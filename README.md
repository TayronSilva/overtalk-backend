---
title: OverTalk Backend
emoji: 🎙️
colorFrom: yellow
colorTo: gray
sdk: docker
pinned: false
---

# OverTalk Backend

API server for OverTalk real-time translation platform.

- Express.js with Supabase auth
- Mercado Pago subscription billing
- Whisper ASR for transcription
- Voice identification (UniSpeech-SAT)
- SSE for real-time streaming

## Environment Variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `MERCADO_PAGO_ACCESS_TOKEN` | Mercado Pago API access token |
