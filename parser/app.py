"""Report pipeline service for the radiology module (modules.radiology).

    POST /report  {previous_report, dictation, assessment, model, reasoning?}
               -> {report, edit_log, sections, usage}

`reasoning` carries the same thinking settings the front end sends with a normal chat
completion ({reasoning_effort?, chat_template_kwargs?}), so the thinking toggle applies here too.
Without it the model uses its own default, which is thinking on for most reasoning models.

The back service forwards the radiologist's inputs here (route /radiology/report,
radiologyServiceUrl in back.json). run_case parses the previous report into sections, asks
the model only where each dictated sentence belongs, applies those edits in code and pastes
the assessment in verbatim.

report_parser.py, router.py and chat_ai.py are unchanged copies from the research repo
umg-radiology-report-formatter (parser_approach/ and scripts/). Make changes there and copy
them over, so the evaluation and this service run the same code.

Reads apiEndpoint and apiKey from back.json, like the back service.
Patient data: report text is never logged and never written to disk.

Usage (from this directory):
    pip install -r requirements.txt
    uvicorn app:app --port 8082
"""

from __future__ import annotations

import json
import logging
import os
import traceback
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from chat_ai import ChatAI, ChatAIError
from router import run_case

# The slowest models in the evaluation took ~10 min per case. A second attempt covers the
# transient 429/5xx of the shared cluster without letting one request run for an hour.
TIMEOUT_S = 600
MAX_RETRIES = 2
MAX_TOKENS = 16000

log = logging.getLogger("uvicorn.error")

# Same config file as the back service
CONFIG_LOCATION = os.getenv("CONFIG_LOCATION", "../secrets/back.json")
try:
    config = json.loads(Path(CONFIG_LOCATION).read_text(encoding="utf-8"))
except (OSError, ValueError):
    config = {}
API_KEY = config.get("apiKey") or ""
API_ENDPOINT = config.get("apiEndpoint") or None  # None: chat_ai's default endpoint
if not API_KEY:
    log.warning("No apiKey in %s: report requests will be refused.", CONFIG_LOCATION)

app = FastAPI(title="Chat AI report pipeline")


class Reasoning(BaseModel):
    # Only these fields reach the model request; anything else is dropped
    reasoning_effort: str | None = None
    chat_template_kwargs: dict | None = None


class ReportRequest(BaseModel):
    previous_report: str
    dictation: str
    assessment: str
    model: str
    reasoning: Reasoning | None = None


@app.post("/report")
def report(request: ReportRequest) -> dict:
    # Plain def, not async: run_case blocks, so FastAPI runs it in a worker thread.
    texts = ("previous_report", "dictation", "assessment", "model")
    missing = [name for name in texts if not getattr(request, name).strip()]
    if missing:
        raise HTTPException(422, f"Missing input: {', '.join(missing)}")
    if not API_KEY:
        raise HTTPException(503, "The report pipeline has no API key (apiKey in back.json).")

    row = {
        "case_id": "chat-ai",
        "pre_report": request.previous_report,
        "delta_report": request.dictation,
        "delta_assessment": request.assessment,
    }
    try:
        reasoning = request.reasoning.model_dump(exclude_none=True) if request.reasoning else {}
        client = ChatAI(
            api_key=API_KEY, base_url=API_ENDPOINT, timeout=TIMEOUT_S, max_retries=MAX_RETRIES,
            extra_body=reasoning,
        )
        result = run_case(client, request.model, row, MAX_TOKENS)
    except ChatAIError as error:
        # Returned to the caller but not logged: upstream error text could quote the request.
        log.warning("Chat AI call failed for model %s", request.model)
        raise HTTPException(502, str(error)) from None
    except Exception as error:
        # Log where it failed, not the message: it may quote report text.
        frame = traceback.extract_tb(error.__traceback__)[-1]
        log.error("Pipeline error %s at %s:%d", type(error).__name__, frame.filename, frame.lineno)
        raise HTTPException(500, f"The report pipeline failed ({type(error).__name__}).") from None

    if "error" in result:
        cut_off = " The answer was cut off." if result.get("finish_reason") == "length" else ""
        raise HTTPException(
            502, f"The model did not return a valid routing ({result['error']}).{cut_off} Try again or use another model."
        )
    return {key: result[key] for key in ("report", "edit_log", "sections", "usage")}
