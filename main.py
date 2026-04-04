from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import edge_tts
import io

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/tts")
async def tts(data: dict):
    text = data.get("text", "")
    voice = data.get("voice", "pt-BR-FranciscaNeural")

    communicate = edge_tts.Communicate(text, voice)
    
    audio_stream = io.BytesIO()

    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_stream.write(chunk["data"])

    audio_stream.seek(0)

    return StreamingResponse(audio_stream, media_type="audio/mpeg")
