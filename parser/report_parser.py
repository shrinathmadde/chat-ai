"""Split a radiology report into labelled sections, without losing a single character.

A report becomes an ordered list of sections, each addressed by a path:

    Befund > Hals > Lymphknoten      "Kein Nachweis suspekter zervikaler Lymphknoten"
    Befund > Thorax > Lymphknoten    "Kein Nachweis suspekter thorakaler Lymphknoten."
    Beurteilung                      "1. Progress mit ..."

The paths are what the LLM will later choose from when it decides where a dictated
sentence belongs; our code, not the LLM, then edits the text.

Every original line is stored in exactly one section, in order, so joining the sections
reproduces the report exactly. `--check` verifies that on every report in the dataset.

Usage:
    .venv/bin/python parser_approach/report_parser.py --check
    .venv/bin/python parser_approach/report_parser.py --case "Progress 1" --side pre
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

DATASET = Path("data/derived/report_pairs.csv")

HEADER = "(Kopfzeile)"  # exam title / technique lines before the first main part

# Main parts of a report, on a line of their own; the colon is sometimes missing.
TOP_LEVEL = re.compile(
    r"^(Anamnese und Fragestellung|Fragestellung|Indikation|Klinik|Technik|CT-Befund|Befund|Beurteilung)"
    r"\s*:?\s*$",
    re.I,
)
# The same main parts with their text on the marker line: "Technik: 2x192-Zeilen Spiral-CT ..."
TOP_INLINE = re.compile(
    r"^(Anamnese und Fragestellung|Fragestellung|Indikation|Klinik|Technik|CT-Befund|Befund|Beurteilung)"
    r"\s*:\s*\S.*$",
    re.I,
)
# "Pharynx: Unauffällig." / "Gallenblase und -wege: ..." / "Thorax:" (text on the next lines)
ITEM = re.compile(r"^([A-ZÄÖÜ][A-Za-zÄÖÜäöüß/(),\- ]{1,45}?)\s*:\s*(.*)$")
# "Hals" / "Muskuloskelettal" — a body region alone on its line
REGION = re.compile(r"^([A-ZÄÖÜ][A-Za-zÄÖÜäöüß/\- ]{2,40})$")

MAX_HEADING_WORDS = 5

# Body regions of a whole-body CT report. Radiologists format these inconsistently — with or
# without a colon, with or without a blank line before — so they are recognised by name.
# "Becken" is left out on purpose: some reports use it as an organ line under Abdomen.
REGION_NAMES = {
    "kopf",
    "hals",
    "halsweichteile",
    "thorax",
    "abdomen",
    "skelett",
    "weichteilmantel",
    "skelett und weichteilmantel",
    "muskuloskelettal",
    "muskuloskelettal/weichteilmantel",
}


@dataclass
class Section:
    path: tuple[str, ...]
    raw: list[str] = field(default_factory=list)  # original lines, verbatim
    label_len: int = 0  # characters of "\n".join(raw) that are the heading label, not content

    @property
    def id(self) -> str:
        return " > ".join(self.path)

    @property
    def heading(self) -> str:
        return self.path[-1]

    @property
    def text(self) -> str:
        """The section's content with its heading label removed."""
        return "\n".join(self.raw)[self.label_len :].strip()


def _is_item(line: str) -> re.Match | None:
    match = ITEM.match(line)
    if not match:
        return None
    heading = match.group(1).strip()
    if re.search(r"\d", heading) or len(heading.split()) > MAX_HEADING_WORDS:
        return None
    return match


def _label_len(line: str) -> int:
    """Length of 'Heading:' plus the spaces after it, measured on the raw (unstripped) line."""
    colon = line.index(":")
    return colon + 1 + (len(line[colon + 1 :]) - len(line[colon + 1 :].lstrip(" \t")))


def parse(report: str) -> list[Section]:
    lines = report.split("\n")
    sections = [Section(path=(HEADER,))]
    seen: Counter[tuple[str, ...]] = Counter()
    top: str | None = None
    region: str | None = None
    pending: str | None = None  # first half of a heading the PDF wrapped onto two lines

    def add(path: tuple[str, ...], raw: list[str], label_len: int) -> None:
        seen[path] += 1
        if seen[path] > 1:  # the same heading twice under one parent
            path = (*path[:-1], f"{path[-1]} #{seen[path]}")
        sections.append(Section(path=path, raw=raw, label_len=label_len))

    def flush_pending() -> None:
        nonlocal pending
        if pending is not None:
            sections[-1].raw.append(pending)
            pending = None

    for index, line in enumerate(lines):
        stripped = line.strip()
        previous_blank = index == 0 or not lines[index - 1].strip()
        next_line = lines[index + 1].strip() if index + 1 < len(lines) else ""
        # Some PDF exports are double-spaced (a blank line after every item), so a region
        # heading is judged by the next line that has content, not the literal next line.
        next_content = next((l.strip() for l in lines[index + 1 :] if l.strip()), "")

        if not stripped:
            flush_pending()
            sections[-1].raw.append(line)
            continue

        top_match = TOP_LEVEL.match(stripped)
        inline_top = TOP_INLINE.match(stripped)
        if top_match or inline_top:
            flush_pending()
            top, region = (top_match or inline_top).group(1).strip(), None
            # "Technik: 2x192-Zeilen ..." carries its text on the marker line
            add((top,), [line], _label_len(line) if inline_top and not top_match else len(line))
            continue

        # Before the findings, and inside the assessment, there is nothing to subdivide.
        if top is None or top.lower() == "beurteilung":
            sections[-1].raw.append(line)
            continue

        item = _is_item(stripped)
        name = (item.group(1) if item else stripped).strip()
        if pending is None and name.lower() in REGION_NAMES:
            region = name
            add((top, region), [line], _label_len(line) if item else len(line))
            continue

        # An unknown "Heading:" with nothing after it, followed by organ lines, is also a region.
        if item and not item.group(2).strip() and pending is None and _is_item(next_content):
            region = item.group(1).strip()
            add((top, region), [line], len(line))
            continue
        if item:
            heading = item.group(1).strip()
            raw, label = [line], _label_len(line)
            if pending is not None:  # "Hirnversorgende" + "Gefäße: ..." is one heading
                heading = f"{pending.strip()} {heading}"
                raw, label = [pending, line], len(pending) + 1 + label
                pending = None
            add((top, region, heading) if region else (top, heading), raw, label)
            continue

        if (
            REGION.match(stripped)
            and previous_blank
            and next_content
            and len(stripped.split()) <= 3
            # Anatomical regions never contain abbreviations; "Letzte CT VU" is a comparison
            # sentence whose date was removed by pseudonymisation.
            and not re.search(r"\b[A-ZÄÖÜ]{2,}\b", stripped)
        ):
            flush_pending()
            region = stripped
            add((top, region), [line], len(line))
            continue

        # A lone word glued to the line above, followed by an item: a wrapped heading.
        if (
            not previous_blank
            and len(stripped.split()) == 1
            and stripped[0].isupper()
            and not stripped.endswith((".", ","))
            and _is_item(next_line)
        ):
            flush_pending()
            pending = line
            continue

        flush_pending()
        sections[-1].raw.append(line)

    flush_pending()
    return [s for s in sections if s.raw]


def render(sections: list[Section]) -> str:
    """Inverse of parse()."""
    return "\n".join(line for section in sections for line in section.raw)


def tree_text(sections: list[Section], preview: int | None = None) -> str:
    """Indented text view of the parsed sections: one heading per line, its text below."""
    lines = []
    for section in sections:
        indent = "    " * (len(section.path) - 1)
        text = " ".join(section.text.split())
        if preview and len(text) > preview:
            text = text[:preview] + "…"
        lines.append(f"{indent}{section.heading}")
        if text:
            lines.append(f"{indent}    {text}")
    return "\n".join(lines)


def print_tree(sections: list[Section]) -> None:
    print(tree_text(sections, preview=70))


def check(rows: list[dict]) -> bool:
    ok = True
    headings: Counter[str] = Counter()
    for row in rows:
        for side in ("pre", "post"):
            report = row[f"{side}_report"]
            sections = parse(report)
            lossless = render(sections) == report
            ok &= lossless
            findings = [s for s in sections if len(s.path) > 1]
            headings.update(s.heading.split(" #")[0] for s in findings)
            status = "ok  " if lossless else "LOST"
            print(f"  {status} {row['case_id']:<12} {side:<5} {len(sections):>3} sections")
    print("\nheadings found below the main parts (count across all 30 reports):")
    for heading, count in sorted(headings.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {count:>3}  {heading}")
    return ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DATASET)
    parser.add_argument("--case", help="print the section tree of one case, e.g. 'Progress 1'")
    parser.add_argument("--side", choices=["pre", "post"], default="pre")
    parser.add_argument("--check", action="store_true", help="round-trip test on every report")
    args = parser.parse_args()

    with args.dataset.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    if args.case:
        row = next((r for r in rows if r["case_id"].lower() == args.case.lower()), None)
        if row is None:
            raise SystemExit(f"unknown case: {args.case}")
        print_tree(parse(row[f"{args.side}_report"]))
        return

    if not check(rows):
        print("\nFAILED: at least one report did not survive parse -> render unchanged")
        sys.exit(1)
    print("\nall reports round-trip losslessly")


if __name__ == "__main__":
    main()
