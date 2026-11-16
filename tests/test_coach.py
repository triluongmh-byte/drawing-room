import json
import math
from types import SimpleNamespace

import numpy as np
import pytest

from drawing_room import coach, scoring
from drawing_room.references import BUILTINS, render


def half_circle():
    return [{"layer": "line", "points": [[500 + 220 * math.cos(math.pi * i / 60), 375 + 220 * math.sin(math.pi * i / 60), 0.5, i]
                                         for i in range(61)]},
            {"layer": "sketch", "points": [[100, 100, 0.5, 0], [140, 110, 0.5, 30]]}]


@pytest.fixture
def result():
    return scoring.score(BUILTINS["circle"], half_circle(), level=1)


def test_prompt_carries_machine_numbers_and_region_ids(result):
    prompt = coach.build_prompt(result, 1, "where did I go wrong?", "Circle", "Read /tmp/x/overlay.png")
    assert f"Shape: {result['shape']}" in prompt and f"Proportion: {result['proportion']}" in prompt
    assert "M1" in prompt and "S1" in prompt
    assert "Level 1" in prompt and "Circle" in prompt
    assert "where did I go wrong?" in prompt
    assert "Read /tmp/x/overlay.png" in prompt
    assert f"{result['stats']['stroke_count']} strokes" in prompt
    assert result["next_step"]["text"] in prompt


def test_prompt_defaults_question_and_level_four_review(result):
    prompt = coach.build_prompt(result, 4, "  ", "Circle", "")
    assert "How did I do" in prompt and "final review" in prompt


def test_system_prompt_forbids_invented_numbers_and_keeps_english():
    assert "never invent" in coach.SYSTEM_PROMPT and "plain English" in coach.SYSTEM_PROMPT


def test_cli_arguments_only_allow_read():
    arguments = coach.cli_arguments(["claude"])
    assert arguments[:2] == ["claude", "-p"]
    assert arguments[arguments.index("--allowedTools") + 1] == "Read"
    assert "--strict-mcp-config" in arguments
    assert arguments[arguments.index("--setting-sources") + 1] == "project"
    assert arguments[arguments.index("--append-system-prompt") + 1] == coach.SYSTEM_PROMPT


def test_coach_runs_cli_in_a_temp_dir_with_both_images(result):
    seen = {}

    def runner(arguments, input, cwd, **kwargs):
        seen.update(prompt=input, files=sorted(p.name for p in cwd.iterdir()), cwd=cwd)
        out = json.dumps({"type": "result", "is_error": False, "result": "Draw the bottom half (M1)."})
        return SimpleNamespace(stdout=out, stderr="", returncode=0)

    answer = coach.coach(render(BUILTINS["circle"]), "Circle", half_circle(), result, 2, "help", runner=runner)
    assert answer == {"reply": "Draw the bottom half (M1).", "route": "claude-cli"}
    assert seen["files"] == ["overlay.png", "reference.png"]
    assert str(seen["cwd"] / "overlay.png") in seen["prompt"]
    assert not seen["cwd"].exists()  # cleaned up afterwards


def test_cli_error_becomes_coach_error(result):
    def runner(*args, **kwargs):
        out = json.dumps({"type": "result", "is_error": True, "result": "not logged in"})
        return SimpleNamespace(stdout=out, stderr="", returncode=1)

    with pytest.raises(coach.CoachError, match="not logged in"):
        coach.coach(render(BUILTINS["circle"]), "Circle", [], result, 2, "", runner=runner)


def test_api_route_sends_images_inline(result):
    calls = []

    class Messages:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text="Good start.")])

    client = SimpleNamespace(beta=SimpleNamespace(messages=Messages()))
    answer = coach.coach(render(BUILTINS["circle"]), "Circle", half_circle(), result, 3, "hi", api_client=client)
    assert answer == {"reply": "Good start.", "route": "api"}
    request = calls[0]
    assert request["model"] == coach.API_MODEL and request["system"] == coach.SYSTEM_PROMPT
    kinds = [block["type"] for block in request["messages"][0]["content"]]
    assert kinds.count("image") == 2 and kinds[-1] == "text"


def test_overlay_marks_reference_ink_and_regions(result):
    image = np.asarray(coach.overlay(render(BUILTINS["circle"]), half_circle(), result))
    reds = (image[..., 0] > 200) & (image[..., 0].astype(int) - image[..., 1] > 40) & (image[..., 2] < 200)
    blacks = image.sum(axis=2) < 60
    yellows = (image[..., 0] > 200) & (image[..., 1] > 150) & (image[..., 2] < 60)
    assert reds.any() and blacks.any() and yellows.any()


def test_parse_stream_prefers_result_text():
    lines = [json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "draft"}]}}),
             json.dumps({"type": "result", "is_error": False, "result": "final"})]
    assert coach.parse_stream("\n".join(lines)) == ("final", None)
    assert coach.parse_stream("garbage\n") == ("", None)
