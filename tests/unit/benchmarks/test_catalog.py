from pathlib import Path

import pytest
from pydantic import ValidationError

from mobile_world.benchmarks import MiniGameTaskSpec, load_catalog, stable_task_id

CONFIG = Path(__file__).parents[3] / "configs" / "longpuzzlebench.json"


def test_catalog_expands_complete_game_matrix() -> None:
    catalog = load_catalog(CONFIG)

    assert catalog.execution.progression_mode == "sequential_unlock"
    assert catalog.execution.stop_on_failure is True
    assert catalog.environment.cycle_detection.required_repetitions == 3
    assert catalog.environment.cycle_detection.coordinate_tolerance_px == 8
    assert catalog.environment.wall_clock_timeout_slack_seconds == 7200.0
    assert len(catalog.tasks) == 114
    assert len(catalog.filter(game_id="bolt_unscrew", difficulty="easy")) == 8
    assert len(catalog.filter(game_id="bolt_unscrew", difficulty="hard")) == 8
    assert not catalog.filter(game_id="bolt_unscrew", difficulty="medium")
    assert len(catalog.filter(game_id="rush_hour_2", difficulty=("easy", "hard"))) == 20
    assert len(catalog.filter(game_id="truck_escape_2")) == 30
    assert len(catalog.filter(game_id="nut_and_bolt")) == 13
    assert len(catalog.filter(game_id="nuts_bolts")) == 13
    assert len(catalog.filter(game_id="nut_and_bolt", difficulty="extreme")) == 3
    assert len(catalog.filter(game_id="nut_and_bolt", difficulty="nightmare")) == 1
    assert len(catalog.filter(game_id="truck_escape", difficulty="default")) == 5
    assert len(catalog.filter(game_id="maze_paint")) == 30
    assert len(catalog.filter(game_id="color_connect")) == 20
    assert {task.seed for task in catalog.tasks} == {0}

    rush_hour = catalog.filter(game_id="rush_hour_2", difficulty="easy")[0]
    nut_and_bolt = catalog.filter(game_id="nut_and_bolt", difficulty="easy")[0]
    assert rush_hour.launch_parameters["game_id"] == "truck_escape_2"
    assert nut_and_bolt.launch_parameters["game_id"] == "nuts_bolts"
    assert catalog.metadata["scoring_version"] == "1.3"
    assert catalog.metadata["truck_escape_2_catalog_version"] == "solver-depth-calibrated-v2"
    assert len(catalog.metadata["scoring_config_hash"]) == 64
    assert all(task.scoring_config is not None for task in catalog.tasks)
    assert all(task.scoring_config_hash for task in catalog.tasks)
    assert nut_and_bolt.scoring_config.mode == "composite"
    assert catalog.experiment.prompt_setting == "full"
    assert catalog.experiment.eval_mode == "progressive"
    assert "context_setting" not in catalog.experiment.model_dump()
    full = load_catalog(CONFIG, prompt_setting="full")
    minimal = load_catalog(CONFIG, prompt_setting="minimal")
    full_text = full.filter(game_id="bolt_unscrew", difficulty="easy")[0].instruction
    minimal_text = minimal.filter(game_id="bolt_unscrew", difficulty="easy")[0].instruction
    assert len(minimal_text) < len(full_text)
    assert "黄色选中环" not in minimal_text
    assert "黄色选中环" in full_text
    assert full.filter(game_id="bolt_unscrew", difficulty="easy")[0].task_id == (
        minimal.filter(game_id="bolt_unscrew", difficulty="easy")[0].task_id
    )


def test_every_game_states_fewer_rules_in_the_minimal_tier() -> None:
    """The two tiers differ only by how much of the rule set is stated.

    Operating constraints (action modality, forbidden buttons, execution
    assumptions) must appear in both tiers, otherwise a score gap between the
    tiers cannot be attributed to withheld game rules.
    """

    minimal = load_catalog(CONFIG, prompt_setting="minimal")
    full = load_catalog(CONFIG, prompt_setting="full")
    minimal_texts = {task.game_id: task.instruction for task in minimal.tasks}
    full_texts = {task.game_id: task.instruction for task in full.tasks}

    assert set(minimal_texts) == set(full_texts)
    for game_id, minimal_text in minimal_texts.items():
        assert len(minimal_text) < len(full_texts[game_id]), game_id

    execution_assumption = "默认合法操作会被环境正确执行"
    assert execution_assumption in minimal_texts["rush_hour_2"]
    assert execution_assumption in full_texts["rush_hour_2"]
    for texts in (minimal_texts, full_texts):
        assert "是drag" in texts["rush_hour_2"]
        assert "可点击螺栓和左下角撤销按钮" in texts["nut_and_bolt"]
        assert "不可点击右上角重开、返回或下一关" in texts["nut_and_bolt"]
        assert "复原" not in texts["nut_and_bolt"]
        assert "復原" not in texts["nut_and_bolt"]


def test_unknown_prompt_setting_is_rejected() -> None:
    with pytest.raises(ValidationError):
        load_catalog(CONFIG, prompt_setting="detailed")  # type: ignore[arg-type]


def test_stable_task_id_and_lookup() -> None:
    catalog = load_catalog(CONFIG)
    task_id = stable_task_id("bolt_unscrew", "easy", 1, 0)

    assert task_id == "bolt_unscrew.easy.level_01.seed_0"
    assert catalog.get_task(task_id).level_id == 1
    assert catalog.filter(task_id=task_id) == (catalog.get_task(task_id),)
    assert catalog.filter(game_id="bolt_unscrew", level_id="1") == catalog.filter(
        game_id="bolt_unscrew", level_id=1
    )
    with pytest.raises(KeyError, match="unknown LongPuzzleBench task"):
        catalog.get_task("missing")


def test_catalog_accepts_legacy_game_and_task_aliases() -> None:
    catalog = load_catalog(CONFIG)
    canonical = catalog.get_task("rush_hour_2.easy.level_01.seed_0")

    assert catalog.get_task("truck_escape_2.easy.level_01.seed_0") == canonical
    assert catalog.filter(task_id="truck_escape_2.easy.level_01.seed_0") == (canonical,)
    assert catalog.filter(game_id="truck_escape_2", level_id="1") == catalog.filter(
        game_id="rush_hour_2", level_id=1
    )
    assert catalog.get_task("nuts_bolts.easy.level_01.seed_0").game_id == "nut_and_bolt"


def test_task_rejects_noncanonical_task_id() -> None:
    with pytest.raises(ValidationError, match="task_id must be"):
        MiniGameTaskSpec(
            task_id="custom",
            game_id="bolt_unscrew",
            difficulty="easy",
            level_id=1,
            instruction="Complete the level.",
        )


def test_stable_task_id_rejects_negative_seed() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        stable_task_id("bolt_unscrew", "easy", 1, -1)
