"""Route the radiologist's dictation into the sections of the previous report.

Pipeline per case:
  1. parse the previous report into addressed sections        (report_parser.py, no LLM)
  2. ask the LLM, under a JSON schema, only WHERE each dictated
     statement goes: replace / append an existing section, or
     add a new section under an existing parent                 (LLM)
  3. apply those edits to the parsed report                     (code)
  4. paste the radiologist's assessment into "Beurteilung"      (code, verbatim)

Sections the dictation does not touch never pass through the LLM, so they cannot change.

Output per case: data/parser_approach/generated/<model>/<Case_N>.json (edits, sections, report)

Usage:
    .venv/bin/python parser_approach/router.py --model glm-4.7 --cases "Stable 4"
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from chat_ai import ChatAI, ChatAIError  # noqa: E402
from report_parser import Section, parse, render  # noqa: E402

DATASET = Path("data/derived/report_pairs.csv")
OUT_ROOT = Path("data/parser_approach/generated")

FINDINGS = {"befund", "ct-befund"}

SYSTEM_PROMPT = """\
Du bist ein Werkzeug zum Schreiben radiologischer Befunde an der Universitätsmedizin Göttingen.
Du triffst keine medizinischen Entscheidungen. Deine einzige Aufgabe ist es, jede Aussage aus
dem Diktat des Radiologen dem richtigen Abschnitt des Vorbefunds zuzuordnen.

Du erhältst die Abschnitte des Vorbefunds, jeweils mit Adresse in eckigen Klammern und dem
aktuellen Text, sowie das Diktat (es enthält nur die Änderungen zur Voruntersuchung).

Mögliche Änderungen:
- "replace" in "edits": Das Diktat ersetzt eine Aussage des Abschnitts. Gib den vollständigen
  neuen Text des Abschnitts zurück: alle Sätze, die weiterhin gelten, unverändert, und die
  ersetzte Aussage durch die Formulierung aus dem Diktat ausgetauscht.
- "append" in "edits": Die Aussage ist für diesen Abschnitt neu. Gib nur den anzuhängenden Text zurück.
- "new_sections": Nur wenn kein vorhandener Abschnitt passt. Wähle den übergeordneten Abschnitt
  und eine passende Überschrift.

Regeln:
1. Übernimm die Formulierungen aus dem Diktat wörtlich. Formuliere nichts um, fasse nichts zusammen.
2. Erfinde keine Befunde, Maße, Serien-/Bildnummern oder Daten.
3. Verwende jede Aussage des Diktats genau einmal. Lass keine Aussage weg.
4. Betreffen mehrere Aussagen denselben Abschnitt, fasse sie zu genau einer Änderung zusammen.
5. Abschnitte, die das Diktat nicht betrifft, erwähnst du nicht.
6. Die Beurteilung wird vom Radiologen separat übernommen. Ordne ihr nichts zu.
"""

USER_TEMPLATE = """\
ABSCHNITTE DES VORBEFUNDS:
{sections}

DIKTAT DES RADIOLOGEN (nur Änderungen):
---
{delta}
---
"""


def targets(sections: list[Section]) -> list[Section]:
    """Sections the dictation may be routed into: everything under the findings part."""
    found = [s for s in sections if s.path[0].lower() in FINDINGS]
    return found or [s for s in sections if s.path[0] != sections[0].path[0]]


def schema(addresses: list[str], parents: list[str]) -> dict:
    edit = {
        "type": "object",
        "properties": {
            "section": {"type": "string", "enum": addresses},
            "action": {"type": "string", "enum": ["replace", "append"]},
            "text": {"type": "string"},
        },
        "required": ["section", "action", "text"],
        "additionalProperties": False,
    }
    new_section = {
        "type": "object",
        "properties": {
            "parent": {"type": "string", "enum": parents},
            "heading": {"type": "string"},
            "text": {"type": "string"},
        },
        "required": ["parent", "heading", "text"],
        "additionalProperties": False,
    }
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "routing",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "edits": {"type": "array", "items": edit},
                    "new_sections": {"type": "array", "items": new_section},
                },
                "required": ["edits", "new_sections"],
                "additionalProperties": False,
            },
        },
    }


def set_text(section: Section, text: str) -> None:
    """Replace a section's content, keeping its heading label and trailing blank lines."""
    joined = "\n".join(section.raw)
    label, rest = joined[: section.label_len], joined[section.label_len :]
    trailing = len(section.raw) - len("\n".join(section.raw).rstrip("\n").split("\n"))
    same_line = bool(rest.strip()) and not rest.startswith("\n")
    if same_line:
        body = label + ("" if label.endswith((" ", "\t")) else " ") + text
    else:
        body = f"{label}\n{text}" if label else text
    section.raw = body.split("\n") + [""] * trailing


def apply(sections: list[Section], routing: dict, assessment: str) -> tuple[list[Section], list[dict]]:
    by_id = {s.id: s for s in sections}
    log = []

    for edit in routing.get("edits", []):
        section = by_id.get(edit["section"])
        if section is None:
            log.append({**edit, "status": "unknown section"})
            continue
        text = edit["text"].strip()
        if edit["action"] == "append" and section.text:
            text = f"{section.text} {text}"
        set_text(section, text)
        log.append({**edit, "status": "applied"})

    for new in routing.get("new_sections", []):
        heading, text = new["heading"].strip().rstrip(":"), new["text"].strip()
        parent = tuple(new["parent"].split(" > "))
        existing = by_id.get(" > ".join((*parent, heading)))
        if existing is not None:  # the model asked for a section that already exists
            set_text(existing, f"{existing.text} {text}".strip())
            log.append({**new, "status": "merged into existing section"})
            continue
        after = max(i for i, s in enumerate(sections) if s.path[: len(parent)] == parent)
        blank = [""] if sections[after].raw and sections[after].raw[-1] == "" else []
        section = Section(path=(*parent, heading), raw=[f"{heading}: {text}", *blank], label_len=len(heading) + 2)
        sections.insert(after + 1, section)
        by_id[section.id] = section
        log.append({**new, "status": "added"})

    verdict = next((s for s in sections if s.path[0].lower() == "beurteilung"), None)
    if verdict is None:
        verdict = Section(path=("Beurteilung",), raw=["", "Beurteilung:"], label_len=len("\nBeurteilung:"))
        sections.append(verdict)
    set_text(verdict, assessment.strip())
    return sections, log


def run_case(client: ChatAI, model: str, row: dict, max_tokens: int) -> dict:
    sections = parse(row["pre_report"])
    routable = targets(sections)
    addresses = [s.id for s in routable]
    parents = [s.id for s in routable if len(s.path) <= 2]
    listing = "\n".join(f"[{s.id}]\n{s.text or '(kein Text)'}" for s in routable)

    result = client.complete(
        model=model,
        system=SYSTEM_PROMPT,
        user=USER_TEMPLATE.format(sections=listing, delta=row["delta_report"]),
        temperature=0.0,
        max_tokens=max_tokens,
        response_format=schema(addresses, parents),
    )
    record = {
        "case_id": row["case_id"],
        "model": model,
        "latency_s": result.latency_s,
        "usage": result.usage,
        "finish_reason": result.finish_reason,
        "raw_output": result.content,
    }
    try:
        routing = json.loads(result.content)
    except json.JSONDecodeError as error:
        return {**record, "error": f"invalid JSON: {error}"}

    edited, log = apply(sections, routing, row["delta_assessment"])
    return {
        **record,
        "routing": routing,
        "edit_log": log,
        "sections": [{"path": list(s.path), "text": s.text} for s in edited],
        "report": render(edited),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", nargs="+", required=True)
    parser.add_argument("--cases", nargs="+")
    parser.add_argument("--max-tokens", type=int, default=16000)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--dataset", type=Path, default=DATASET)
    parser.add_argument("--out-root", type=Path, default=OUT_ROOT)
    args = parser.parse_args()

    with args.dataset.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if args.cases:
        wanted = {c.lower() for c in args.cases}
        rows = [r for r in rows if r["case_id"].lower() in wanted]
    client = ChatAI()

    for model in args.model:
        out_dir = args.out_root / model
        out_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n=== {model} — {len(rows)} case(s)")

        def work(row: dict) -> dict:
            try:
                return run_case(client, model, row, args.max_tokens)
            except ChatAIError as error:
                return {"case_id": row["case_id"], "model": model, "error": str(error)}

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for record in pool.map(work, rows):
                path = out_dir / f"{record['case_id'].replace(' ', '_')}.json"
                path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
                if record.get("error"):
                    print(f"  {record['case_id']:<12} FAILED  {record['error'][:90]}")
                    continue
                statuses = [e["status"] for e in record["edit_log"]]
                print(
                    f"  {record['case_id']:<12} {len(record['routing']['edits'])} edits, "
                    f"{len(record['routing']['new_sections'])} new  {record['latency_s']:>6.1f}s"
                    f"{'  ' + str(statuses) if any(s != 'applied' for s in statuses) else ''}"
                )


if __name__ == "__main__":
    main()
