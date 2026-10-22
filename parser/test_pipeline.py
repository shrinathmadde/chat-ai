"""Checks for the report pipeline that need no model call.

    python test_pipeline.py        (or: python -m pytest test_pipeline.py)
"""

from __future__ import annotations

from report_parser import FOOTER, parse, render, sentence_spans
from router import apply, numbered, schema, targets

REPORT = """\
CT Thorax/Abdomen

Befund:
Lunge: Kein Rundherd. Kein Pleuraerguss.
Lymphknoten: Keine vergrößerten Lymphknoten. Keine Nekrosen.
Leber: Metastase in Segment 7 (Serie 3, Ima 45). Größenkonstant zur VU.

Beurteilung:
1. Kein Tumornachweis."""

SIGNED = REPORT + """

Mit freundlichen Grüßen
Dr. med. Muster
Oberärztin"""


def sentences(text: str) -> list[str]:
    return [text[a:b] for a, b in sentence_spans(text)]


def routed(report: str, edits: list[dict], new_sections: list[dict] | None = None,
           assessment: str = "Neu.") -> tuple[str, list[dict]]:
    """The report after the given routing, as run_case applies it."""
    sections = parse(report)
    _, ids = numbered(targets(sections))
    edited, log = apply(sections, {"edits": edits, "new_sections": new_sections or []}, ids, assessment)
    return render(edited), log


def test_sentences() -> None:
    assert sentences("Raumforderung (Serie 14, Ima 467). Bekannte Imbibierung.") == [
        "Raumforderung (Serie 14, Ima 467).", "Bekannte Imbibierung."]
    assert sentences("Metastase der 8. Rippe links. Image 139. Kein Erguss.") == [
        "Metastase der 8. Rippe links.", "Image 139.", "Kein Erguss."]
    assert sentences("Herd im li. Unterlappen, ca. 3 mm. V.a. Metastase. Z.n. OP.") == [
        "Herd im li. Unterlappen, ca. 3 mm.", "V.a. Metastase.", "Z.n. OP."]
    # a line break wraps a sentence; it does not end one
    assert sentences("Kein Nachweis einer\nRaumforderung. Neu") == ["Kein Nachweis einer\nRaumforderung.", "Neu"]


def test_footer_is_kept_and_not_the_assessment() -> None:
    sections = parse(SIGNED)
    assert render(sections) == SIGNED
    assert [s.path for s in sections][-2:] == [("Beurteilung",), (FOOTER,)]
    report, _ = routed(SIGNED, [], assessment="1. Progress.")
    assert report.endswith("Beurteilung:\n1. Progress.\n\nMit freundlichen Grüßen\nDr. med. Muster\nOberärztin")
    assert all(FOOTER not in s.id for s in targets(sections))


def test_sentence_about_a_doctor_is_not_a_footer() -> None:
    report = REPORT + "\nDr. Muster telefonisch informiert."
    assert parse(report)[-1].path == ("Beurteilung",)
    assert parse(REPORT + "\nDr. med. Muster")[-1].path == (FOOTER,)


def test_new_assessment_goes_before_the_footer() -> None:
    unassessed = SIGNED.replace("Beurteilung:\n1. Kein Tumornachweis.\n\n", "")
    report, _ = routed(unassessed, [], assessment="1. Progress.")
    assert "Größenkonstant zur VU.\n\nBeurteilung:\n1. Progress.\n\nMit freundlichen Grüßen" in report
    report, _ = routed(REPORT.replace("\n\nBeurteilung:\n1. Kein Tumornachweis.", ""), [], assessment="1. Progress.")
    assert report.endswith("Größenkonstant zur VU.\n\nBeurteilung:\n1. Progress.")


def test_report_without_headings_is_one_section() -> None:
    assert [s.id for s in targets(parse("Lunge frei. Kein Erguss."))] == ["(Kopfzeile)"]
    assert targets(parse("Beurteilung:\nKein Tumornachweis.")) == []


def test_schema_never_has_an_empty_enum() -> None:
    replaces = schema(["Befund"], ["Befund"], [])["json_schema"]["schema"]["properties"]["edits"]["items"]
    assert replaces["properties"]["replaces"]["items"]["enum"] == ["S0"]


def test_numbered_sentences_are_replaced_whole() -> None:
    # S1 Kein Rundherd, S2 Kein Pleuraerguss, S3/S4 Lymphknoten, S5/S6 Leber
    report, log = routed(REPORT, [{"section": "Befund > Lunge", "replaces": ["S2"],
                                   "text": "Neu Pleuraerguss rechts."}])
    assert "Lunge: Kein Rundherd. Neu Pleuraerguss rechts.\n" in report
    assert log[0]["status"] == "replaced 1"


def test_sentence_of_another_section_is_taken_out() -> None:
    report, log = routed(REPORT, [{"section": "Befund > Lymphknoten", "replaces": ["S3", "S2"],
                                   "text": "Neu LK 12 mm mit Pleuraerguss."}])
    assert "Lunge: Kein Rundherd.\n" in report
    assert "Lymphknoten: Neu LK 12 mm mit Pleuraerguss. Keine Nekrosen.\n" in report
    assert log[0]["status"] == "replaced 1, removed 1 in other sections"


def test_two_edits_on_one_sentence_stand_together() -> None:
    report, log = routed(REPORT, [
        {"section": "Befund > Lymphknoten", "replaces": ["S3"], "text": "Neu 12 mm LK paratracheal."},
        {"section": "Befund > Lymphknoten", "replaces": ["S3"], "text": "Neu 8 mm LK hilär."},
    ])
    assert "Lymphknoten: Neu 12 mm LK paratracheal. Neu 8 mm LK hilär. Keine Nekrosen.\n" in report
    assert [e["status"] for e in log] == ["replaced 1", "replaced 1"]


def test_section_emptied_keeps_its_heading() -> None:
    report, _ = routed(REPORT, [{"section": "Befund > Lymphknoten", "replaces": ["S1", "S2"],
                                 "text": "Lunge frei."}])
    assert "\nLunge:\nLymphknoten:" in report


def test_new_section_with_existing_name_is_merged() -> None:
    report, log = routed(REPORT, [], new_sections=[{"parent": "Befund", "heading": "lunge", "text": "Neu Erguss."}])
    assert "Lunge: Kein Rundherd. Kein Pleuraerguss. Neu Erguss.\n" in report
    assert log[0]["status"] == "merged into existing section"


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print(f"ok  {test.__name__}")
    print(f"\n{len(tests)} passed")
