from fastapi import FastAPI
from youtube_transcript_api import YouTubeTranscriptApi

app = FastAPI()

@app.get("/transcript")
def get_transcript(videoId: str):
    try:
        ytt = YouTubeTranscriptApi()
        fetched = ytt.fetch(videoId)
        transcript = " ".join([s.text for s in fetched])
        return {"transcript": transcript, "hasTranscript": True}
    except Exception as e:
        return {"transcript": "", "hasTranscript": False, "error": str(e)}