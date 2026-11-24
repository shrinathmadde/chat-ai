"""Checks for the report pipeline that need no model call.

    python test_pipeline.py        (or: python -m pytest test_pipeline.py)
"""

from __future__ import annotations

from rebase import (looks_unparsed, rebase, rebase_comparison_date, strip_image_references,
                    strip_markdown)
from report_parser import FOOTER, parse, render, sentence_spans
from router import (INSTRUCTIONS_RULE, SYSTEM_PROMPT, USER_TEMPLATE, apply, numbered, routing_prompts,
                    schema, targets)

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


def test_technique_is_routable_but_the_header_is_not() -> None:
    # A radiologist dictates the technique too, so it needs an address of its own; the
    # header has none, because nobody dictates the exam title.
    report = "CT Thorax\n\nTechnik: 128-Zeilen CT. Gesamt-DLP 885 mGy*cm.\n\n" + REPORT.split("\n\n", 1)[1]
    ids = [s.id for s in targets(parse(report))]
    assert "Technik" in ids
    assert "(Kopfzeile)" not in ids
    assert all("Beurteilung" not in i for i in ids)


# --- rebase: statements about the previous examination itself ---------------


def test_markdown_report_is_parsed_like_a_plain_one() -> None:
    plain = parse(REPORT)
    decorated = parse(rebase(
        "# CT Thorax/Abdomen\n\n## Befund\n\n"
        "**Lunge:** Kein Rundherd. Kein Pleuraerguss.\n"
        "**Lymphknoten:** Keine vergrößerten Lymphknoten. Keine Nekrosen.\n"
        "**Leber:** Metastase in Segment 7. Größenkonstant zur VU.\n\n"
        "## Beurteilung\n\n1. Kein Tumornachweis."
    ))
    assert [s.id for s in decorated] == [s.id for s in plain]
    # Without this the whole report is one section and a single "sentence" spans
    # several findings sections, so naming one deletes all of them.
    assert not looks_unparsed(decorated)
    assert len(sentence_spans(decorated[-1].text)) == 1


def test_guard_separates_an_unparsed_report_from_a_short_one() -> None:
    # A dictation-style report without headings is one section on purpose, and routable
    assert not looks_unparsed(parse("Lunge frei. Kein Erguss."))
    # But one section holding several paragraphs means the headings were not recognised
    assert looks_unparsed(parse("Bericht\n\nLunge frei.\n\nKein Erguss."))


def test_markdown_keeps_a_single_asterisk() -> None:
    # "Gesamt-DLP von 885 mGy*cm." is content, not emphasis
    line = "Technik: Gesamt-DLP von 885 mGy*cm. Zweite Messung 900 mGy*cm."
    assert strip_markdown(line) == line
    assert strip_markdown("**Abdomen:** frei") == "Abdomen: frei"
    assert strip_markdown("## Befund") == "Befund"


def test_image_references_go_but_measurements_stay() -> None:
    assert strip_image_references("Konkrement (Serie 2/Bild 59).") == "Konkrement."
    assert strip_image_references("Nebenmilz (Serie 2/Bild 48), unauffällig.") == "Nebenmilz, unauffällig."
    # The parentheses often hold the radiologist's measurement as well
    assert strip_image_references("LK (SAD 1,2 cm, Serie 5, Ima 88).") == "LK (SAD 1,2 cm)."
    assert strip_image_references("Herd (aktuell 4 mm, Serie 6, Image 133, VU 7 mm).") == \
        "Herd (aktuell 4 mm, VU 7 mm)."
    # A parenthesis the radiologist never closed, seen in the real reports
    assert strip_image_references("Unterlappen (Serie 12/Image 311 sowie links.") == \
        "Unterlappen sowie links."
    # Parentheses without a reference are left exactly as they are
    assert strip_image_references("Zyste (BOSNIAK I).") == "Zyste (BOSNIAK I)."


def test_comparison_date_becomes_the_previous_exam_date() -> None:
    report = ("CT Thorax vom 30.06.2026 15:28\n\nBefund:\n"
              "Es liegen Voruntersuchungen zum Vergleich vor, zuletzt vom 07.05.2026.\n"
              "Lunge: Kein Rundherd.")
    assert "zuletzt vom 30.06.2026." in rebase_comparison_date(report)
    # Ambiguous or absent dates are left alone: a wrong date is worse than a stale one
    assert rebase_comparison_date(report.replace("vom 30.06.2026 15:28", "")) == \
        report.replace("vom 30.06.2026 15:28", "")
    two = report.replace("Befund:", "Befund:\nVoruntersuchung vom 01.01.2026.")
    assert rebase_comparison_date(two) == two
    # A date in parentheses dates a measurement, not the report's comparison basis:
    # "(VU vom 07.05.2026 ca. 2 mm)" says what this lesion measured in *that* exam, so
    # moving the date would attribute the old measurement to the wrong examination.
    annotated = ("CT Thorax vom 30.06.2026\n\nBefund:\n"
                 "Lunge: Nodulus 4 mm (VU vom 07.05.2026 ca. 2 mm). Kein Erguss.")
    assert rebase_comparison_date(annotated) == annotated


def test_rebase_does_not_disturb_a_plain_report() -> None:
    assert rebase(REPORT.replace(" (Serie 3, Ima 45)", "")) == REPORT.replace(" (Serie 3, Ima 45)", "")
    assert render(parse(rebase(REPORT))) == rebase(REPORT)  # still lossless


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


def test_edit_with_empty_text_only_takes_out() -> None:
    report, _ = routed(REPORT, [{"section": "Befund > Lunge", "replaces": ["S2"], "text": ""}])
    assert "Lunge: Kein Rundherd.\nLymphknoten:" in report
    report, _ = routed(REPORT, [{"section": "Befund > Lunge", "replaces": [], "text": " "}])
    assert "Lunge: Kein Rundherd. Kein Pleuraerguss.\n" in report


def test_prompts_without_instructions_are_unchanged() -> None:
    from app import ASSESSMENT_REQUEST, ASSESSMENT_SYSTEM_PROMPT, assessment_prompts

    listing, _ = numbered(targets(parse(REPORT)))
    for instructions in ("", "  \n"):
        assert routing_prompts(listing, "Neu Erguss.", instructions) == (
            SYSTEM_PROMPT, USER_TEMPLATE.format(sections=listing, delta="Neu Erguss."))
        system, user = assessment_prompts(REPORT, "Neu Erguss.", instructions)
        assert system == ASSESSMENT_SYSTEM_PROMPT
        assert "HINWEISE" not in user and user.endswith("Neu Erguss.\n---\n" + ASSESSMENT_REQUEST)


def test_instructions_reach_both_prompts() -> None:
    from app import ASSESSMENT_REQUEST, ASSESSMENT_SYSTEM_PROMPT, assessment_prompts

    listing, _ = numbered(targets(parse(REPORT)))
    block = "HINWEISE DES RADIOLOGEN:\n---\nBitte ausformulieren.\n---\n"
    system, user = routing_prompts(listing, "Neu Erguss.", " Bitte ausformulieren.\n")
    # one rule after the six of each prompt
    assert "\n6. " in SYSTEM_PROMPT and system == SYSTEM_PROMPT + INSTRUCTIONS_RULE
    assert user.endswith("Neu Erguss.\n---\n\n" + block)
    system, user = assessment_prompts(REPORT, "Neu Erguss.", "Bitte ausformulieren.")
    assert "\n6. " in ASSESSMENT_SYSTEM_PROMPT and system == ASSESSMENT_SYSTEM_PROMPT + INSTRUCTIONS_RULE
    assert user.endswith("Neu Erguss.\n---\n\n" + block + ASSESSMENT_REQUEST)


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
