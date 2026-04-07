import json
import os
import tempfile
from pathlib import Path
from typing import Any

import edge_tts
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel


DEFAULT_VOICES = [
    {
        "id": "sofia",
        "name": "Sofia",
        "description": "Feminina brasileira, natural e suave",
        "locale": "pt-BR",
        "gender": "female",
        "edge_voice": "pt-BR-FranciscaNeural",
    },
    {
        "id": "caio",
        "name": "Caio",
        "description": "Masculina brasileira, clara e profissional",
        "locale": "pt-BR",
        "gender": "male",
        "edge_voice": "pt-BR-AntonioNeural",
    },
]


def parse_voice_catalog() -> list[dict[str, Any]]:
    raw = os.getenv("AVAILABLE_VOICES_JSON", "").strip()
    if not raw:
        return DEFAULT_VOICES

    try:
        payload = json.loads(raw)
        if not isinstance(payload, list):
            return DEFAULT_VOICES

        voices = []
        for item in payload:
            voice_id = str(item.get("id", "")).strip()
            voice_name = str(item.get("name", voice_id)).strip()
            edge_voice = str(item.get("edge_voice", item.get("edgeVoice", ""))).strip()

            if not voice_id or not voice_name or not edge_voice:
                continue

            voices.append(
                {
                    "id": voice_id,
                    "name": voice_name,
                    "description": str(item.get("description", "Voz gratuita")).strip(),
                    "locale": str(item.get("locale", "pt-BR")).strip(),
                    "gender": str(item.get("gender", "")).strip() or None,
                    "edge_voice": edge_voice,
                }
            )

        return voices or DEFAULT_VOICES
    except Exception:
        return DEFAULT_VOICES


def public_voice_shape(voice: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": voice["id"],
        "name": voice["name"],
        "description": voice.get("description") or "Voz gratuita",
        "locale": voice.get("locale") or "pt-BR",
        "gender": voice.get("gender"),
        "provider": "custom",
    }


def find_voice(voice_id: str | None) -> dict[str, Any]:
    catalog = parse_voice_catalog()
    clean_voice_id = str(voice_id or "").strip()
    for voice in catalog:
        if voice["id"] == clean_voice_id:
            return voice
    return catalog[0]


def validate_api_key(authorization: str | None, x_api_key: str | None) -> None:
    expected_key = os.getenv("TTS_API_KEY", "").strip()
    if not expected_key:
        return

    bearer_key = ""
    if authorization and authorization.startswith("Bearer "):
        bearer_key = authorization.removeprefix("Bearer ").strip()

    if x_api_key == expected_key or bearer_key == expected_key:
        return

    raise HTTPException(status_code=401, detail="unauthorized")


class TTSRequest(BaseModel):
    text: str
    voice_id: str | None = None


app = FastAPI(title="render-tts-multivoz")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    catalog = parse_voice_catalog()
    return {
        "ok": True,
        "service": "render-tts-multivoz",
        "default_voice_id": catalog[0]["id"],
        "voices": [public_voice_shape(voice) for voice in catalog],
    }


@app.get("/voices")
def voices():
    catalog = parse_voice_catalog()
    return {
        "provider": "custom",
        "default_voice_id": catalog[0]["id"],
        "voices": [public_voice_shape(voice) for voice in catalog],
    }


@app.post("/tts")
async def tts(
    body: TTSRequest,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="x-api-key"),
):
    validate_api_key(authorization, x_api_key)

    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text_required")

    max_text_length = int(os.getenv("MAX_TEXT_LENGTH", "5000"))
    safe_text = text[:max_text_length]
    selected_voice = find_voice(body.voice_id)

    rate = os.getenv("TTS_RATE", "+0%")
    volume = os.getenv("TTS_VOLUME", "+0%")
    pitch = os.getenv("TTS_PITCH", "+0Hz")

    temp_dir = Path(tempfile.gettempdir())
    output_file = temp_dir / f"tts-{next(tempfile._get_candidate_names())}.mp3"

    try:
        communicate = edge_tts.Communicate(
            safe_text,
            selected_voice["edge_voice"],
            rate=rate,
            volume=volume,
            pitch=pitch,
        )
        await communicate.save(str(output_file))
        audio_bytes = output_file.read_bytes()
        return Response(content=audio_bytes, media_type="audio/mpeg")
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"tts_failed: {error}") from error
    finally:
        if output_file.exists():
            try:
                output_file.unlink()
            except Exception:
                pass


@app.exception_handler(HTTPException)
async def http_error_handler(_, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
