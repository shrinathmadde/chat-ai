"""Route the radiologist's dictation into the sections of the previous report.

Pipeline per case:
  1. parse the previous report into addressed sections and
     number its sentences S1, S2, ...                           (report_parser.py, no LLM)
  2. ask the LLM, under a JSON schema, only WHERE each dictated
     statement goes and which sentences (by number) it makes
     untrue, or which new section it needs                      (LLM)
  3. apply them: the numbered sentences are taken out, the
     dictated text stands in place of the first one             (code)
  4. paste the radiologist's assessment into "Beurteilung"      (code, verbatim)

Sections the dictation does not touch never pass through the LLM, so they cannot change. In
the sections it does touch the model retypes nothing: it names whole sentences by number, so
every other sentence stays exactly as it was. Quoting the sentences instead let a model quote a
whole section in one go and so delete findings that still held.

The dictation goes in word for word, unless the radiologist's instructions (routing_prompts)
ask otherwise, e.g. to write it out in full sentences.

Output per case: data/parser_approach/generated/<model>/<Case_N>.json (edits, sections, report)

Usage:
    .venv/bin/python parser_approach/router.py --model glm-4.7 --cases "Stable 4"
"""

from __future__ import annotations

import argparse
import csv
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from chat_ai import ChatAI, ChatAIError
from report_parser import FOOTER, Section, is_findings, parse, render, sentence_spans

DATASET = Path("data/derived/report_pairs.csv")
OUT_ROOT = Path("data/parser_approach/generated")

SYSTEM_PROMPT = """\
Du bist ein Werkzeug zum Schreiben radiologischer Befunde an der Universitätsmedizin Göttingen.
Du triffst keine medizinischen Entscheidungen. Deine einzige Aufgabe ist es, jede Aussage aus
dem Diktat des Radiologen dem richtigen Abschnitt des Vorbefunds zuzuordnen.

Du erhältst die Abschnitte des Vorbefunds, jeweils mit Adresse in eckigen Klammern und dem
aktuellen Text, sowie das Diktat (es enthält nur die Änderungen zur Voruntersuchung).

Für jede Änderung in "edits":
- "section": der Abschnitt, zu dem die Aussage gehört.
- "replaces": die Nummern (S1, S2, ...) der Sätze des Vorbefunds, die nach dem Diktat nicht
  mehr zutreffen, auch wenn sie in einem anderen Abschnitt stehen. Das sind insbesondere:
  * Negativbefunde ("Kein ...", "Keine ...", "Kein Nachweis ...", "unauffällig", "regelrecht"),
    wenn das Diktat zu diesem Thema nun einen Befund nennt;
  * frühere Maße, Größenangaben oder Verlaufsangaben ("größenkonstant", "größenregredient")
    desselben Befunds.
  Leere Liste, wenn das Diktat keiner Aussage des Vorbefunds widerspricht und nur etwas ergänzt.
  Sätze, die weiterhin zutreffen, nennst du nicht.
- "text": die Aussage aus dem Diktat.
"new_sections": Nur wenn kein vorhandener Abschnitt passt. Wähle den übergeordneten Abschnitt
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

# Only when the radiologist typed instructions (the text box in the web interface). Without
# them the prompts are exactly the ones above, so the evaluated behaviour stays as it was.
# Rule 7 of both prompts: the assessment prompt (app.py) has six rules too.
INSTRUCTIONS_RULE = (
    "7. Befolge die HINWEISE DES RADIOLOGEN, auch wenn sie den Regeln oben widersprechen.\n"
    "   Erfinde aber auch dann nichts.\n"
)

INSTRUCTIONS_TEMPLATE = """\
HINWEISE DES RADIOLOGEN:
---
{instructions}
---
"""


def routing_prompts(listing: str, delta: str, instructions: str = "") -> tuple[str, str]:
    """System and user prompt of the routing call; the instructions only when there are any."""
    system, user = SYSTEM_PROMPT, USER_TEMPLATE.format(sections=listing, delta=delta)
    if instructions.strip():
        system += INSTRUCTIONS_RULE
        user += "\n" + INSTRUCTIONS_TEMPLATE.format(instructions=instructions.strip())
    return system, user


def targets(sections: list[Section]) -> list[Section]:
    """Sections the dictation may be routed into: everything under the findings part.

    Never the assessment, not even in a report without a findings heading: apply() replaces
    it at the end, so a dictated sentence routed there would vanish from the report. Never the
    footer either. A report without any heading is one section, the header.
    """
    body = [s for s in sections if s.path[0].lower() != "beurteilung" and s.path[0] != FOOTER]
    found = [s for s in body if is_findings(s.path[0])]
    return found or [s for s in body if s.path[0] != sections[0].path[0]] or body


def numbered(routable: list[Section]) -> tuple[str, dict[str, tuple[str, int, int]]]:
    """The listing the model sees, and sentence number -> (section id, start, end) in its text.

    Numbers run through the whole report, so a sentence of another section can be named too.
    """
    ids, blocks = {}, []
    for section in routable:
        lines = [f"[{section.id}]"]
        spans = sentence_spans(section.text)
        if not spans:
            lines.append("(kein Text)")
        for start, end in spans:
            number = f"S{len(ids) + 1}"
            ids[number] = (section.id, start, end)
            lines.append(f"{number}: {' '.join(section.text[start:end].split())}")
        blocks.append("\n".join(lines))
    return "\n".join(blocks), ids


def schema(addresses: list[str], parents: list[str], sentences: list[str]) -> dict:
    edit = {
        "type": "object",
        "properties": {
            "section": {"type": "string", "enum": addresses},
            # Before "text", so the model decides what no longer holds before it writes.
            # An empty enum is an invalid schema (HTTP 500), so a report without sentences
            # gets a number that names nothing.
            "replaces": {"type": "array", "items": {"type": "string", "enum": sentences or ["S0"]}},
            "text": {"type": "string"},
        },
        "required": ["section", "replaces", "text"],
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
    if same_line and not text:  # every sentence taken out: the heading alone
        body = label.rstrip(" \t")
    elif same_line:
        body = label + ("" if label.endswith((" ", "\t")) else " ") + text
    else:
        body = f"{label}\n{text}" if label and text else label or text
    section.raw = body.split("\n") + [""] * trailing


def rebuild(text: str, spans: list[tuple[str, int, int]], removed: set[str],
            anchors: dict[str, list[str]], appended: list[str]) -> str:
    """A section's text without the removed sentences, each edit's text in place of the first
    sentence it removed there, or after the text when it removed none there. An edit with an
    empty text only takes sentences out (asked for in the radiologist's instructions)."""
    parts, last = [], 0
    for number, start, end in spans:
        separator, last = text[last:start], end
        if number in anchors:
            piece = " ".join(t for t in anchors[number] if t)
            if piece:
                parts.append((separator, piece))
        elif number not in removed:
            parts.append((separator, text[start:end]))
    out = ""
    for separator, piece in parts:
        out += (separator if out else "") + piece
    for piece in filter(None, appended):
        out = f"{out} {piece}" if out else piece
    return out.strip()


def apply(sections: list[Section], routing: dict, ids: dict[str, tuple[str, int, int]],
          assessment: str) -> tuple[list[Section], list[dict]]:
    by_id = {s.id: s for s in sections}
    log = []

    # All edits of a section at once, on its original sentences: two edits that take out the same
    # sentence then both stand in its place, instead of the second finding it gone
    plans: dict[str, dict] = {}

    def plan(section_id: str) -> dict:
        return plans.setdefault(section_id, {"removed": set(), "anchors": {}, "appended": []})

    for edit in routing.get("edits", []):
        section = by_id.get(edit["section"])
        if section is None:
            log.append({**edit, "status": "unknown section"})
            continue
        chosen = [n for n in dict.fromkeys(edit.get("replaces", [])) if n in ids]
        for number in chosen:
            plan(ids[number][0])["removed"].add(number)
        here = sorted((n for n in chosen if ids[n][0] == section.id), key=lambda n: ids[n][1])
        if here:
            plan(section.id)["anchors"].setdefault(here[0], []).append(edit["text"].strip())
        else:
            plan(section.id)["appended"].append(edit["text"].strip())
        elsewhere = len(chosen) - len(here)
        status = f"replaced {len(here)}" if here else "appended"
        log.append({**edit, "status": status + (f", removed {elsewhere} in other sections" if elsewhere else "")})

    for section_id, steps in plans.items():
        section = by_id[section_id]
        spans = [(n, start, end) for n, (owner, start, end) in ids.items() if owner == section_id]
        set_text(section, rebuild(section.text, spans, steps["removed"], steps["anchors"], steps["appended"]))

    by_name = {s.id.lower(): s for s in sections}
    for new in routing.get("new_sections", []):
        heading, text = new["heading"].strip().rstrip(":"), new["text"].strip()
        parent = tuple(new["parent"].split(" > "))
        existing = by_name.get(" > ".join((*parent, heading)).lower())
        if existing is not None:  # the model asked for a section that already exists
            set_text(existing, f"{existing.text} {text}".strip())
            log.append({**new, "status": "merged into existing section"})
            continue
        after = max(i for i, s in enumerate(sections) if s.path[: len(parent)] == parent)
        blank = [""] if sections[after].raw and sections[after].raw[-1] == "" else []
        section = Section(path=(*parent, heading), raw=[f"{heading}: {text}", *blank], label_len=len(heading) + 2)
        sections.insert(after + 1, section)
        by_name[section.id.lower()] = section
        log.append({**new, "status": "added"})

    verdict = next((s for s in sections if s.path[0].lower() == "beurteilung"), None)
    if verdict is None:  # a new one, before the signature if there is one
        footer = next((i for i, s in enumerate(sections) if s.path[0] == FOOTER), len(sections))
        # one blank line before it: the section above may end with one already
        above = sections[footer - 1].raw if footer else []
        head = ["Beurteilung:"] if above and above[-1] == "" else ["", "Beurteilung:"]
        raw = [*head, ""] if footer < len(sections) else head
        verdict = Section(path=("Beurteilung",), raw=raw, label_len=len("\n".join(head)))
        sections.insert(footer, verdict)
    set_text(verdict, assessment.strip())
    return sections, log


def run_case(client: ChatAI, model: str, row: dict, max_tokens: int) -> dict:
    sections = parse(row["pre_report"])
    routable = targets(sections)
    if not routable:
        raise ValueError("the previous report has no findings to update")
    addresses = [s.id for s in routable]
    parents = [s.id for s in routable if len(s.path) <= 2] or addresses[:1]
    listing, ids = numbered(routable)
    system, user = routing_prompts(listing, row["delta_report"], row.get("instructions", ""))

    result = client.complete(
        model=model,
        system=system,
        user=user,
        temperature=0.0,
        max_tokens=max_tokens,
        response_format=schema(addresses, parents, list(ids)),
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

    edited, log = apply(sections, routing, ids, row["delta_assessment"])
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
                print(
                    f"  {record['case_id']:<12} {len(record['routing']['edits'])} edits, "
                    f"{len(record['routing']['new_sections'])} new  {record['latency_s']:>6.1f}s"
                )


if __name__ == "__main__":
    main()
