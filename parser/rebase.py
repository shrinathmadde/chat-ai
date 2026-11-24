"""Re-base a previous report onto a new examination, before it is parsed.

The pipeline writes the follow-up by reusing the previous report's text: sections the
dictation does not touch are copied verbatim, which is what keeps findings from silently
changing. A few sentences, though, describe the *previous examination's own context*
rather than the patient, and become wrong the moment they are carried into a new report.
The radiologist has dictated nothing about them, so the router correctly leaves them
alone; they are fixed here instead, deterministically and without a model call.

  * Series and image references. "(Serie 2/Bild 59)" points into the previous exam's
    image stack, which does not exist in the new one. Across the 15 real pre/post pairs
    in data/derived/report_pairs.csv the radiologists re-cited 20 of 21 references with
    the new exam's numbers and carried exactly one over, and 13 references arrive in the
    dictation itself. So a reference inherited from the previous report is dropped, while
    the ones the radiologist dictates are inserted by the router as dictated.
    Only the reference is dropped, not the parentheses around it: they often also hold a
    measurement ("(SAD 1,2 cm, Serie 5, Ima 88)") which is the radiologist's finding.

  * The comparison date. "zuletzt vom 07.05.2026" names the exam the *previous* report
    compared against. In the new report the most recent prior is the previous report
    itself, so its own date, from its header, takes that place.

  * Markdown decorations, for a different reason: a report pasted from an LLM arrives with
    "## Befund" and "**Abdomen:**". The markers hide the headings from report_parser's
    TOP_LEVEL and the sentence ends from SENTENCE_END, so the whole report collapses into
    one section and single "sentences" span whole findings sections. They are never
    rendered anywhere in the app, so they are simply removed.

Run before parse(), never inside it: parse() -> render() must stay lossless.
"""

from __future__ import annotations

import re

from report_parser import HEADER, parse

# --- markdown ---------------------------------------------------------------

# "## Befund" -> "Befund". TOP_LEVEL's colon is optional, so nothing is added back.
ATX = re.compile(r"^[ \t]*#{1,6}[ \t]+")
# "**Abdomen:**" -> "Abdomen:". Only the *paired* form: a single "*" is content,
# as in "Gesamt-DLP von 885 mGy*cm."
STRONG = re.compile(r"(?<!\*)\*\*(?!\*)(.+?)(?<!\*)\*\*(?!\*)")
UNDER = re.compile(r"(?<!_)__(?!_)(.+?)(?<!_)__(?!_)")


def strip_markdown(report: str) -> str:
    """Remove the markdown decorations that hide a report's structure."""
    return "\n".join(
        UNDER.sub(r"\1", STRONG.sub(r"\1", ATX.sub("", line)))
        for line in report.split("\n")
    )


# --- series / image references ----------------------------------------------

# "Serie 5, Ima 88" / "Serie 10/Bild 412" / "Se 6 Image 133" / "Serie 11/Bild 81,300".
# A line break may sit anywhere inside, because reports are copied out of PDFs.
_SERIES = r"(?:Serie|Ser\.?|Se)\s*\d+"
_IMAGE = r"(?:Bild|Ima\.?|Image|Img)\s*\d+(?:\s*,\s*\d+)*"
REFERENCE = re.compile(rf"{_SERIES}\s*[/,;]?\s*{_IMAGE}", re.I | re.S)
# One parenthesis group without nested ones, so "(a (b)" cannot be matched as a whole.
# The spaces before it are part of the match: when the whole group goes, they go with it.
GROUP = re.compile(r"([ \t]*)\(([^()]*)\)", re.S)
# A reference behind a parenthesis the radiologist never closed, which GROUP cannot match.
# Once in the 15 reports: "... rechten Unterlappen (Serie 12/Image 311 sowie von ca. 6 mm
# im ... Unterlappen (Serie 12/Image 304)." Here the space before "(" is kept, because
# the sentence continues after the reference.
ORPHAN = re.compile(rf"\(\s*(?:{REFERENCE.pattern})\s*", re.I | re.S)


def _clean_group(match: re.Match) -> str:
    """One parenthesis group with its series/image reference removed. The group goes too
    when nothing but the reference was in it; what is left keeps its own punctuation."""
    space, inner = match.group(1), REFERENCE.sub("", match.group(2))
    if not REFERENCE.search(match.group(2)):
        return match.group(0)  # no reference in here: leave the group exactly as it was
    # Separators the reference left behind: ", ," / "( ," / ", )" / "(/"
    inner = re.sub(r"\s*[,;/]\s*(?=[,;/])", "", inner)
    inner = inner.strip().strip(",;/ \t\n").strip()
    return f"{space}({inner})" if inner else ""


def strip_image_references(report: str) -> str:
    """Drop series/image references inherited from the previous exam, keeping any
    measurement that shares their parentheses."""
    return ORPHAN.sub("", GROUP.sub(_clean_group, report))


# --- the comparison date ----------------------------------------------------

_DATE = r"\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})"
# "... nativ vom 30.06.2026 15:28" in the report's first lines: the exam's own date
HEADER_DATE = re.compile(rf"\bvom\s+({_DATE})")
# "Es liegen Voruntersuchungen zum Vergleich vor, zuletzt vom 07.05.2026."
COMPARISON = re.compile(
    rf"\b(zuletzt|Voruntersuchung(?:en)?|Vorbefund(?:e)?|VU)\b([^.\n]{{0,40}}?\bvom\s+)({_DATE})",
    re.I,
)
# A date in parentheses belongs to a measurement, not to the report's comparison basis:
# "Nodulus 4 mm (VU vom 07.05.2026 ca. 2 mm)" says what this lesion measured in that exam.
# Moving that date would attribute the old measurement to the wrong examination.
PARENTHESES = re.compile(r"\([^()]*\)", re.S)
def rebase_comparison_date(report: str) -> str:
    """Put the previous report's own exam date where it names the exam *it* compared
    against. Only when both dates are unambiguous: a confidently wrong date would be
    worse than a visibly stale one, which the radiologist can see and correct.

    The exam's own date stands in the title block, which is the parser's header section,
    and the comparison line stands below it — so the two are told apart by position, not
    by wording.
    """
    sections = parse(report)
    if not sections or sections[0].path[0] != HEADER:
        return report  # the report has no title block, so there is no date to take
    head = "\n".join(sections[0].raw)  # parse keeps the lines verbatim: a prefix of report
    dates = set(HEADER_DATE.findall(head))
    if len(dates) != 1:
        return report
    exam_date = dates.pop()

    annotations = [m.span() for m in PARENTHESES.finditer(report)]
    matches = [
        m
        for m in COMPARISON.finditer(report)
        if m.start() >= len(head)
        and not any(start <= m.start(3) < end for start, end in annotations)
    ]
    if len(matches) != 1 or matches[0].group(3) == exam_date:
        return report
    match = matches[0]
    return report[: match.start(3)] + exam_date + report[match.end(3) :]


# --- entry point ------------------------------------------------------------


def rebase(report: str) -> str:
    """The previous report, ready to be parsed and reused for a new examination."""
    return rebase_comparison_date(strip_image_references(strip_markdown(report)))


# --- the guard --------------------------------------------------------------


def looks_unparsed(sections: list) -> bool:
    """Whether the parser failed to find the structure a report plainly has.

    A short dictation-style report without any heading is one section on purpose
    (targets() routes into it). But a single section holding several paragraphs means the
    headings were there and were not recognised, and then sentence numbering runs across
    section boundaries: naming one sentence deletes whole findings. Refuse instead.
    """
    return len(sections) == 1 and re.search(r"\n[ \t]*\n", sections[0].text) is not None
