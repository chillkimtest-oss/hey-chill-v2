import asyncio
import json
import os
import numpy as np
from fastapi import FastAPI, WebSocket, Request, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse, StreamingResponse, RedirectResponse
import uvicorn
import logging
from prompts import PROMPTS
from openai_realtime_client import OpenAIRealtimeAudioTextClient
from starlette.websockets import WebSocketState
import wave
import scipy.signal
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from typing import Generator, Optional
from llm_processor import get_llm_processor
from datetime import datetime, timedelta
import time
import websockets
from config import OPENAI_REALTIME_MODEL, OPENAI_REALTIME_MODALITIES

# Gemini transcription import is deferred to runtime inside the endpoint

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Pydantic models for request and response schemas
class ReadabilityRequest(BaseModel):
    text: str = Field(..., description="The text to improve readability for.")

class ReadabilityResponse(BaseModel):
    enhanced_text: str = Field(..., description="The text with improved readability.")

class CorrectnessRequest(BaseModel):
    text: str = Field(..., description="The text to check for factual correctness.")

class CorrectnessResponse(BaseModel):
    analysis: str = Field(..., description="The factual correctness analysis.")

class AskAIRequest(BaseModel):
    text: str = Field(..., description="The question to ask AI.")

class AskAIResponse(BaseModel):
    answer: str = Field(..., description="AI's answer to the question.")

app = FastAPI()

@app.get("/health")
async def health_check():
    return {"status": "ok"}

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    logger.error("OPENAI_API_KEY is not set in environment variables.")
    raise EnvironmentError("OPENAI_API_KEY is not set.")

# Initialize with a default model
llm_processor = get_llm_processor("gpt-4o")  # Default processor

@app.get("/static/main.js")
async def get_main_js():
    logger.info("Serving main.js via custom route")
    headers = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
    return FileResponse("static/main.js", media_type="application/javascript", headers=headers)

@app.get("/sw.js")
async def get_sw():
    """Serve service worker from root path so its scope covers the full origin."""
    headers = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
    return FileResponse("static/sw.js", media_type="application/javascript", headers=headers)

@app.get("/manifest.json")
async def get_manifest():
    """Serve PWA manifest from root path."""
    headers = {"Cache-Control": "public, max-age=86400"}
    return FileResponse("static/manifest.json", media_type="application/manifest+json", headers=headers)

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", response_class=HTMLResponse)
async def get_realtime_page(request: Request):
    # Default to WebSocket version (old version)
    return FileResponse("static/realtime.html")

@app.get("/old", response_class=HTMLResponse)
async def get_old_ws_page(request: Request):
    # Redirect to root (WebSocket version)
    return RedirectResponse(url="/", status_code=302)


class AudioProcessor:
    def __init__(self, target_sample_rate=24000):
        self.target_sample_rate = target_sample_rate
        self.source_sample_rate = 48000  # Most common sample rate for microphones
        
    def process_audio_chunk(self, audio_data):
        # Convert binary audio data to Int16 array
        pcm_data = np.frombuffer(audio_data, dtype=np.int16)
        
        # Convert to float32 for better precision during resampling
        float_data = pcm_data.astype(np.float32) / 32768.0
        
        # Resample from 48kHz to 24kHz
        resampled_data = scipy.signal.resample_poly(
            float_data, 
            self.target_sample_rate, 
            self.source_sample_rate
        )
        
        # Convert back to int16 while preserving amplitude
        resampled_int16 = (resampled_data * 32768.0).clip(-32768, 32767).astype(np.int16)
        return resampled_int16.tobytes()

    def save_audio_buffer(self, audio_buffer, filename):
        with wave.open(filename, 'wb') as wf:
            wf.setnchannels(1)  # Mono audio
            wf.setsampwidth(2)  # 2 bytes per sample (16-bit)
            wf.setframerate(self.target_sample_rate)
            wf.writeframes(b''.join(audio_buffer))
        logger.info(f"Saved audio buffer to {filename}")

@app.websocket("/api/v1/ws")
async def websocket_endpoint(websocket: WebSocket):
    logger.info("New WebSocket connection attempt")
    await websocket.accept()
    logger.info("WebSocket connection accepted, starting receive_messages task")
    
    # Add initial status update here
    await websocket.send_text(json.dumps({
        "type": "status",
        "status": "idle"  # Set initial status to idle (blue)
    }, ensure_ascii=False))
    
    client = None
    audio_processor = AudioProcessor()
    audio_buffer = []
    recording_stopped = asyncio.Event()
    openai_ready = asyncio.Event()
    pending_audio_chunks = []
    clear_on_next_response = False
    is_recording = False
    marker_prefix = "下面是不改变语言的语音识别结果：\n\n"
    max_prefix_deltas = 20
    response_buffer = []
    marker_seen = False
    delta_counter = 0

    async def emit_text_delta(content: str):
        if content and websocket.client_state == WebSocketState.CONNECTED:
            await websocket.send_text(json.dumps({
                "type": "text",
                "content": content,
                "isNewResponse": False
            }, ensure_ascii=False))

    async def flush_buffer(with_warning: bool = False):
        nonlocal response_buffer
        if not response_buffer:
            return
        buffered_text = "".join(response_buffer)
        response_buffer = []
        # Try to remove marker prefix (with or without trailing newlines)
        if buffered_text.startswith(marker_prefix):
            buffered_text = buffered_text[len(marker_prefix):]
        elif buffered_text.startswith(marker_prefix.rstrip('\n')):
            # Handle case where prefix doesn't have trailing newlines
            buffered_text = buffered_text[len(marker_prefix.rstrip('\n')):].lstrip('\n')
        # Also check if prefix appears anywhere in the text
        marker_index = buffered_text.find(marker_prefix)
        if marker_index != -1:
            buffered_text = buffered_text[marker_index + len(marker_prefix):]
        else:
            marker_index = buffered_text.find(marker_prefix.rstrip('\n'))
            if marker_index != -1:
                buffered_text = buffered_text[marker_index + len(marker_prefix.rstrip('\n')):].lstrip('\n')
        if with_warning and not buffered_text:
            logger.warning("Buffered text discarded after removing marker prefix.")
        await emit_text_delta(buffered_text)
    
    async def create_realtime_client(model: str = None) -> OpenAIRealtimeAudioTextClient:
        """Create OpenAI realtime client with given model."""
        selected_model = model or OPENAI_REALTIME_MODEL
        logger.info(f"Creating OpenAI client with model: {selected_model}")
        return OpenAIRealtimeAudioTextClient(OPENAI_API_KEY, model=selected_model)
    
    async def initialize_realtime_client(model: str = None):
        nonlocal client
        try:
            openai_ready.clear()
            client = await create_realtime_client(model=model)
            await client.connect(modalities=OPENAI_REALTIME_MODALITIES)
            logger.info("Successfully connected to OpenAI client")
            
            # Register handlers after client is initialized
            client.register_handler("session.updated", lambda data: handle_generic_event("session.updated", data))
            client.register_handler("input_audio_buffer.cleared", lambda data: handle_generic_event("input_audio_buffer.cleared", data))
            client.register_handler("input_audio_buffer.speech_started", lambda data: handle_generic_event("input_audio_buffer.speech_started", data))
            client.register_handler("rate_limits.updated", lambda data: handle_generic_event("rate_limits.updated", data))
            client.register_handler("response.output_item.added", lambda data: handle_generic_event("response.output_item.added", data))
            client.register_handler("conversation.item.created", lambda data: handle_generic_event("conversation.item.created", data))
            client.register_handler("response.content_part.added", lambda data: handle_generic_event("response.content_part.added", data))
            client.register_handler("response.text.done", lambda data: handle_generic_event("response.text.done", data))
            client.register_handler("response.content_part.done", lambda data: handle_generic_event("response.content_part.done", data))
            client.register_handler("response.output_item.done", lambda data: handle_generic_event("response.output_item.done", data))
            client.register_handler("response.done", lambda data: handle_response_done(data))
            client.register_handler("error", lambda data: handle_error(data))
            client.register_handler("response.text.delta", lambda data: handle_text_delta(data))
            # GA: response.text.delta → response.output_text.delta
            client.register_handler("response.output_text.delta", lambda data: handle_text_delta(data))
            client.register_handler("response.created", lambda data: handle_response_created(data))
            client.register_handler("input_audio_buffer.speech_stopped", lambda data: handle_generic_event("input_audio_buffer.speech_stopped", data))
            client.register_handler("input_audio_buffer.committed", lambda data: handle_generic_event("input_audio_buffer.committed", data))
            client.register_handler("conversation.item.added", lambda data: handle_generic_event("conversation.item.added", data))
            client.register_handler("conversation.item.input_audio_transcription.completed", lambda data: handle_generic_event("conversation.item.input_audio_transcription.completed", data))
            client.register_handler("response.output_audio.done", lambda data: handle_generic_event("response.output_audio.done", data))
            client.register_handler("ping", lambda data: handle_generic_event("ping", data))
            
            openai_ready.set()  # Set ready flag after successful initialization
            await websocket.send_text(json.dumps({
                "type": "status",
                "status": "connected"
            }, ensure_ascii=False))
            return True
        except Exception as e:
            logger.error(f"Failed to connect to OpenAI client: {e}")
            openai_ready.clear()  # Ensure flag is cleared on failure
            await websocket.send_text(json.dumps({
                "type": "error",
                "content": "Failed to initialize OpenAI connection"
            }, ensure_ascii=False))
            return False

    # Move the handler definitions here (before initialize_realtime_client)
    async def handle_text_delta(data):
        nonlocal response_buffer, marker_seen, delta_counter
        try:
            if websocket.client_state != WebSocketState.CONNECTED:
                logger.warning("WebSocket not connected, ignoring text delta")
                return

            delta = data.get("delta", "")
            logger.debug(f"Received text delta: {repr(delta[:50])} (marker_seen={marker_seen}, buffer_size={len(response_buffer)}, delta_counter={delta_counter})")

            if marker_seen:
                if delta:
                    await emit_text_delta(delta)
                    logger.debug(f"Handled response.text.delta (passthrough): {repr(delta[:50])}")
                return

            if delta:
                response_buffer.append(delta)
                delta_counter += 1

            joined = "".join(response_buffer)
            # Try to find marker prefix (with or without newlines)
            marker_index = joined.find(marker_prefix)
            # Also try without the trailing newlines in case x.ai returns differently
            if marker_index == -1:
                marker_prefix_no_newline = marker_prefix.rstrip('\n')
                marker_index = joined.find(marker_prefix_no_newline)
                if marker_index != -1:
                    # Found prefix without trailing newlines, skip past it
                    marker_seen = True
                    remaining = joined[marker_index + len(marker_prefix_no_newline):].lstrip('\n')
                    response_buffer = []
                    if remaining:
                        await emit_text_delta(remaining)
                    logger.info(f"Handled response.text.delta (marker detected without newline), emitted: {repr(remaining[:50])}")
                    return

            if marker_index != -1:
                marker_seen = True
                remaining = joined[marker_index + len(marker_prefix):]
                response_buffer = []
                await emit_text_delta(remaining)
                logger.info(f"Handled response.text.delta (marker detected), emitted: {repr(remaining[:50])}")
                return

            if delta_counter >= max_prefix_deltas:
                marker_seen = True
                await flush_buffer(with_warning=True)
                logger.warning("Marker prefix not detected after max deltas; emitted buffered text.")
            else:
                logger.debug(f"Handled response.text.delta (buffering), total buffer length: {len(joined)}")
        except Exception as e:
            logger.error(f"Error in handle_text_delta: {str(e)}", exc_info=True)

    async def handle_response_created(data):
        # Only clear UI on the first response after an explicit Start from the user
        nonlocal clear_on_next_response, response_buffer, marker_seen, delta_counter
        response_buffer = []
        marker_seen = False
        delta_counter = 0
        logger.info(f"Handled response.created, clearing buffer and resetting marker state")
        if clear_on_next_response:
            await websocket.send_text(json.dumps({
                "type": "text",
                "content": "",
                "isNewResponse": True
            }, ensure_ascii=False))
            clear_on_next_response = False
        logger.info("Handled response.created")

    async def handle_error(data):
        error_msg = data.get("error", {}).get("message", "Unknown error")
        logger.error(f"OpenAI error: {error_msg}")
        await websocket.send_text(json.dumps({
            "type": "error",
            "content": error_msg
        }, ensure_ascii=False))
        # Ensure clients exit generating state even if OpenAI aborts the turn
        await websocket.send_text(json.dumps({
            "type": "status",
            "status": "idle"
        }, ensure_ascii=False))
        logger.info("Handled error message from OpenAI")

    async def handle_response_done(data):
        nonlocal client, response_buffer, marker_seen
        logger.info(f"Handled response.done (marker_seen={marker_seen}, buffer_size={len(response_buffer)})")
        if not marker_seen and response_buffer:
            logger.info("Flushing remaining buffer content")
            await flush_buffer()
            marker_seen = True
        
        recording_stopped.set()
        
        # Update frontend status to idle
        try:
            await websocket.send_text(json.dumps({
                "type": "status",
                "status": "idle"
            }, ensure_ascii=False))
        except Exception as e:
            logger.error(f"Error sending status after response done: {str(e)}", exc_info=True)
        
        # Close the OpenAI client connection (not the user WebSocket)
        # The user WebSocket should remain open for the next request
        if client:
            logger.info("Response completed, closing OpenAI client connection")
            try:
                await client.close()
                client = None
                openai_ready.clear()
            except Exception as e:
                logger.error(f"Error closing OpenAI client: {str(e)}", exc_info=True)

    async def handle_generic_event(event_type, data):
        logger.info(f"Handled {event_type} with data: {json.dumps(data, ensure_ascii=False)}")

    # Create a queue to handle incoming audio chunks
    audio_queue = asyncio.Queue()

    async def receive_messages():
        nonlocal client
        logger.info("receive_messages task started")
        
        try:
            while True:
                if websocket.client_state == WebSocketState.DISCONNECTED:
                    logger.info("WebSocket client disconnected")
                    openai_ready.clear()
                    break
                    
                try:
                    # Add timeout to prevent infinite waiting
                    logger.info("Waiting for message from client (timeout=30s)...")
                    data = await asyncio.wait_for(websocket.receive(), timeout=30.0)
                    logger.info(f"Received data from client: {list(data.keys())}")
                except asyncio.CancelledError:
                    logger.info("Receive messages task cancelled")
                    raise
                except asyncio.TimeoutError:
                    logger.debug("No message received for 30 seconds")
                    continue
                except Exception as e:
                    logger.error(f"Error receiving message: {str(e)}", exc_info=True)
                    break
                
                if "bytes" in data:
                    processed_audio = audio_processor.process_audio_chunk(data["bytes"])
                    if not openai_ready.is_set():
                        logger.debug("OpenAI not ready, buffering audio chunk")
                        pending_audio_chunks.append(processed_audio)
                    elif client and is_recording:
                        await client.send_audio(processed_audio)
                        await websocket.send_text(json.dumps({
                            "type": "status",
                            "status": "connected"
                        }, ensure_ascii=False))
                        logger.debug(f"Sent audio chunk, size: {len(processed_audio)} bytes")
                    else:
                        logger.warning("Received audio but client is not initialized")
                            
                elif "text" in data:
                    msg = json.loads(data["text"])
                    logger.info(f"Received message from client: {msg.get('type')}")
                    
                    if msg.get("type") == "start_recording":
                        logger.info("Processing start_recording request")
                        
                        # Update status to connecting while initializing realtime client
                        await websocket.send_text(json.dumps({
                            "type": "status",
                            "status": "connecting"
                        }, ensure_ascii=False))
                        model = msg.get("model")
                        logger.info(f"Received start_recording: model={model}")
                        if not await initialize_realtime_client(model=model):
                            continue
                        recording_stopped.clear()
                        pending_audio_chunks.clear()
                        # Immediately clear transcript for a new client-initiated request
                        await websocket.send_text(json.dumps({
                            "type": "text",
                            "content": "",
                            "isNewResponse": True
                        }, ensure_ascii=False))
                        clear_on_next_response = False
                        is_recording = True
                        
                        # Send any buffered chunks
                        if pending_audio_chunks and client:
                            logger.info(f"Sending {len(pending_audio_chunks)} buffered chunks")
                            for chunk in pending_audio_chunks:
                                await client.send_audio(chunk)
                            pending_audio_chunks.clear()
                        
                    elif msg.get("type") == "stop_recording":
                        # On explicit Stop, force-commit and force-create a response, then wait for completion.
                        if client:
                            # Immediately stop accepting further audio for this turn
                            is_recording = False
                            try:
                                await client.commit_audio()
                                logger.info("Audio committed, starting response...")
                                await client.start_response(PROMPTS['paraphrase-gpt-realtime-enhanced'])
                                logger.info("Response started successfully")
                            except Exception as e:
                                logger.error(f"Error committing/starting response on stop: {str(e)}", exc_info=True)
                                # If we fail to kick off a response, surface that we're no longer recording
                                await websocket.send_text(json.dumps({
                                    "type": "status",
                                    "status": "idle"
                                }, ensure_ascii=False))
                                continue
                            # Wait until the response is finished
                            await recording_stopped.wait()
                
        finally:
            # Cleanup when the loop exits
            if client:
                try:
                    await client.close()
                except Exception as e:
                    logger.error(f"Error closing client in receive_messages: {str(e)}")
            logger.info("Receive messages loop ended")

    async def send_audio_messages():
        try:
            while True:
                
                try:
                    processed_audio = await audio_queue.get()
                    if processed_audio is None:
                        break
                    
                    # Add validation
                    if len(processed_audio) == 0:
                        logger.warning("Empty audio chunk received, skipping")
                        continue
                    
                    # Append the processed audio to the buffer
                    audio_buffer.append(processed_audio)

                    await client.send_audio(processed_audio)
                    logger.info(f"Audio chunk sent to OpenAI client, size: {len(processed_audio)} bytes")
                    
                except asyncio.CancelledError:
                    logger.info("Send audio messages task cancelled")
                    raise
                except Exception as e:
                    logger.error(f"Error in send_audio_messages: {str(e)}", exc_info=True)
                    break
        except asyncio.CancelledError:
            logger.info("Send audio messages task cancelled")
            raise

        # After processing all audio, set the event
        recording_stopped.set()

    # Start concurrent tasks for receiving and sending
    receive_task = asyncio.create_task(receive_messages())
    send_task = asyncio.create_task(send_audio_messages())

    try:
        # Wait for both tasks to complete
        await asyncio.gather(receive_task, send_task)
    except Exception as e:
        logger.error(f"Error in WebSocket connection: {e}", exc_info=True)
    finally:
        # Cancel background tasks before cleanup
        receive_task.cancel()
        send_task.cancel()
        
        # Wait for tasks to be cancelled (with timeout)
        try:
            await asyncio.wait_for(asyncio.gather(receive_task, send_task, return_exceptions=True), timeout=1.0)
        except asyncio.TimeoutError:
            logger.warning("Tasks did not cancel within timeout")
        except Exception as e:
            logger.debug(f"Error cancelling tasks: {e}")
        
        if client:
            await client.close()
        if websocket.client_state != WebSocketState.DISCONNECTED:
            try:
                await websocket.close()
            except RuntimeError as e:
                logger.warning(f"Ignoring error during websocket close: {e}")
        logger.info("WebSocket connection closed for /api/v1/ws")

@app.post(
    "/api/v1/readability",
    response_model=ReadabilityResponse,
    summary="Enhance Text Readability",
    description="Improve the readability of the provided text using GPT-4o."
)
async def enhance_readability(request: ReadabilityRequest):
    prompt = PROMPTS.get('readability-enhance')
    if not prompt:
        raise HTTPException(status_code=500, detail="Readability prompt not found.")

    try:
        async def text_generator():
            # Use gpt-4o specifically for readability
            async for part in llm_processor.process_text(request.text, prompt, model="gpt-4o"):
                yield part

        return StreamingResponse(text_generator(), media_type="text/plain")

    except Exception as e:
        logger.error(f"Error enhancing readability: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Error processing readability enhancement.")

# TEMPORARILY DISABLED - Ask AI API endpoint
# @app.post(
#     "/api/v1/ask_ai",
#     response_model=AskAIResponse,
#     summary="Ask AI a Question",
#     description="Ask AI to provide insights using O1-mini model."
# )
# def ask_ai(request: AskAIRequest):
#     prompt = PROMPTS.get('ask-ai')
#     if not prompt:
#         raise HTTPException(status_code=500, detail="Ask AI prompt not found.")

#     try:
#         # Use o3-mini specifically for ask_ai
#         answer = llm_processor.process_text_sync(request.text, prompt, model="gpt-4.1")
#         return AskAIResponse(answer=answer)
#     except Exception as e:
#         logger.error(f"Error processing AI question: {e}", exc_info=True)
#         raise HTTPException(status_code=500, detail="Error processing AI question.")

@app.post(
    "/api/v1/correctness",
    response_model=CorrectnessResponse,
    summary="Check Factual Correctness",
    description="Analyze the text for factual accuracy using GPT-4o."
)
async def check_correctness(request: CorrectnessRequest):
    prompt = PROMPTS.get('correctness-check')
    if not prompt:
        raise HTTPException(status_code=500, detail="Correctness prompt not found.")

    try:
        async def text_generator():
            async for part in llm_processor.process_text(request.text, prompt, model="gpt-4o-search-preview"):
                yield part

        return StreamingResponse(text_generator(), media_type="text/plain")

    except Exception as e:
        logger.error(f"Error checking correctness: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Error processing correctness check.")

if __name__ == '__main__':
    uvicorn.run(app, host="0.0.0.0", port=3005)
