"""Report pipeline service for the radiology module (modules.radiology).

    POST /report  {previous_report, dictation, assessment?, model, reasoning?}
               -> {report, edit_log, sections, usage, assessment_generated}

`reasoning` carries the same thinking settings the front end sends with a normal chat
completion ({reasoning_effort?, chat_template_kwargs?}), so the thinking toggle applies here too.
Without it the model uses its own default, which is thinking on for most reasoning models.

The back service forwards the radiologist's inputs here (route /radiology/report,
radiologyServiceUrl in back.json). run_case parses the previous report into sections, asks
the model only where each dictated sentence belongs, applies those edits in code and pastes
the assessment in verbatim. Without a dictated assessment, a second call, made at the same
time, has the model update the previous report's assessment (write_assessment).

report_parser.py, router.py and chat_ai.py started as copies from the research repo
umg-radiology-report-formatter, but this directory is the main code now: change them here.

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
import re
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from chat_ai import ChatAI, ChatAIError, Completion
from report_parser import parse
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
    assessment: str = ""  # empty: the model updates the previous assessment
    model: str
    reasoning: Reasoning | None = None


# The model keeps the previous assessment's form but never its course judgement. It updates the
# previous assessment instead of writing one, so points that still hold keep their wording and
# only real changes show as changes in the report editor.
ASSESSMENT_SYSTEM_PROMPT = """\
Du bist ein Assistenzsystem für die Radiologie der Universitätsmedizin Göttingen (UMG).
Der Radiologe hat zur aktuellen Untersuchung nur die Änderungen im Befund diktiert, aber keine
Beurteilung. Aktualisiere die Beurteilung des Vorbefunds für die aktuelle Untersuchung.

Regeln:
1. Übernimm jeden Punkt der bisherigen Beurteilung, der nach dem Diktat weiterhin zutrifft,
   wörtlich. Ändere nur, was das Diktat betrifft, und ergänze klinisch relevante neue Befunde
   aus dem Diktat. Hat der Vorbefund keine Beurteilung, formuliere eine knappe neue.
2. FORM — übernimm die äußere Form der bisherigen Beurteilung: War sie nummeriert (1., 2., ...),
   nummeriere ebenfalls; war sie Fließtext, schreibe Fließtext. Orientiere dich auch an ihrer
   Länge und Detailtiefe.
3. INHALT — übernimm auf keinen Fall das Verlaufsurteil der bisherigen Beurteilung. Das
   Verlaufsurteil (Progress, stable disease, Regress) leitest du ausschließlich neu her, indem du
   das Diktat mit dem Befund des Vorbefunds vergleichst. Formulierungen wie "weiterhin
   Therapieansprechen" oder "im Verlauf stable disease" darfst du nur dann verwenden, wenn das
   Diktat sie inhaltlich bestätigt. Nenne die Verlaufsaussage explizit, mit Angabe des
   Verlaufsintervalls, sofern ableitbar.
4. Wenn das Diktat zu einem bisher beurteilten Aspekt (z. B. Fernmetastasen,
   Lymphknotenstatus) nichts Gegenteiliges sagt, benenne den bisherigen Status weiterhin.
5. Erfinde nichts. Nenne keine Befunde, Maße, Serien-/Bildnummern oder Datumsangaben, die
   weder im Vorbefund noch im Diktat stehen.
6. Gib ausschließlich den Text der neuen Beurteilung aus, ohne die Überschrift "Beurteilung":
   kein Markdown, keine Sternchen, keine Einleitung, keine Kommentare und keine Rückfragen.
   Antworte auf Deutsch.
"""

ASSESSMENT_USER_TEMPLATE = """\
VORBEFUND (Voruntersuchung):
---
{previous_report}
---

BISHERIGE BEURTEILUNG (aus dem Vorbefund):
---
{previous_assessment}
---

DIKTAT DES RADIOLOGEN ZUR AKTUELLEN UNTERSUCHUNG (nur die Änderungen):
---
{dictation}
---

Gib jetzt die aktualisierte Beurteilung der aktuellen Untersuchung aus.
"""

# run_case pastes the assessment in verbatim, so without one it pastes this, and the updated
# assessment replaces it afterwards
ASSESSMENT_SLOT = "[[ASSESSMENT_SLOT]]"
HEADING = re.compile(r"^\s*Beurteilung\s*:?[ \t]*\n?", re.IGNORECASE)


def previous_assessment(previous_report: str) -> str:
    """The previous report's assessment, as written, without its heading."""
    raw = "\n".join(
        "\n".join(section.raw)
        for section in parse(previous_report)
        if section.path[0].lower() == "beurteilung"
    )
    return HEADING.sub("", raw).strip()


def write_assessment(client: ChatAI, model: str, previous_report: str, dictation: str) -> Completion:
    """Second call: the updated assessment as plain text, no routing."""
    return client.complete(
        model=model,
        system=ASSESSMENT_SYSTEM_PROMPT,
        user=ASSESSMENT_USER_TEMPLATE.format(
            previous_report=previous_report,
            previous_assessment=previous_assessment(previous_report) or "(keine)",
            dictation=dictation,
        ),
        temperature=0.0,
        max_tokens=MAX_TOKENS,
    )


def add_usage(first: dict, second: dict) -> dict:
    """Token counts of both calls, for the token display under the report."""
    keys = ("prompt_tokens", "completion_tokens", "total_tokens")
    return {key: (first.get(key) or 0) + (second.get(key) or 0) for key in keys}


@app.post("/report")
def report(request: ReportRequest) -> dict:
    # Plain def, not async: run_case blocks, so FastAPI runs it in a worker thread.
    texts = ("previous_report", "dictation", "model")
    missing = [name for name in texts if not getattr(request, name).strip()]
    if missing:
        raise HTTPException(422, f"Missing input: {', '.join(missing)}")
    if not API_KEY:
        raise HTTPException(503, "The report pipeline has no API key (apiKey in back.json).")

    generate = not request.assessment.strip()
    row = {
        "case_id": "chat-ai",
        "pre_report": request.previous_report,
        "delta_report": request.dictation,
        "delta_assessment": ASSESSMENT_SLOT if generate else request.assessment,
    }
    try:
        reasoning = request.reasoning.model_dump(exclude_none=True) if request.reasoning else {}

        def client() -> ChatAI:
            # One per call: the two calls run in parallel threads
            return ChatAI(
                api_key=API_KEY, base_url=API_ENDPOINT, timeout=TIMEOUT_S, max_retries=MAX_RETRIES,
                extra_body=reasoning,
            )

        # The assessment needs only the inputs, not the routed findings, so both calls run at
        # the same time and the report takes as long as the slower one
        with ThreadPoolExecutor(max_workers=2) as pool:
            routed = pool.submit(run_case, client(), request.model, row, MAX_TOKENS)
            written = (
                pool.submit(write_assessment, client(), request.model, request.previous_report,
                            request.dictation)
                if generate else None
            )
            result = routed.result()
            assessment = written.result() if written else None
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

    if generate:
        text = HEADING.sub("", assessment.content).strip()
        if assessment.truncated or not text:
            cut_off = " The answer was cut off." if assessment.truncated else ""
            raise HTTPException(
                502, f"The model did not write an assessment.{cut_off} Try again, use another model or add the assessment."
            )
        if ASSESSMENT_SLOT not in result["report"]:
            log.error("Assessment slot missing from the routed report")
            raise HTTPException(500, "The report pipeline failed (assessment slot).")
        result["report"] = result["report"].replace(ASSESSMENT_SLOT, text)
        for section in result["sections"]:
            section["text"] = section["text"].replace(ASSESSMENT_SLOT, text)
        result["usage"] = add_usage(result["usage"], assessment.usage)

    return {
        **{key: result[key] for key in ("report", "edit_log", "sections", "usage")},
        "assessment_generated": generate,
    }
