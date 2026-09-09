from mobile_world.core.cli import create_parser


def test_autonomous_and_legacy_command_defaults_are_separate():
    parser = create_parser()
    autonomous = parser.parse_args(["autonomous", "--game", "maze_paint", "--difficulty", "easy"])
    assert autonomous.step_wait_time == 2.0
    assert (
        parser.parse_args(
            ["autonomous", "--game", "maze_paint", "--difficulty", "easy", "--step-wait-time", "1"]
        ).step_wait_time
        == 1
    )
    assert autonomous.timeout == 3600
    assert autonomous.capture_surface == "desktop"
    assert autonomous.level is None
    legacy = parser.parse_args(["eval", "--game", "maze_paint", "--difficulty", "easy"])
    assert legacy.timeout is None
    assert legacy.agent_type == "general_e2e"
    assert not hasattr(legacy, "capture_surface")


def test_autonomous_logging_defaults_and_debug_option():
    parser = create_parser()
    arguments = ["autonomous", "--game", "maze_paint", "--difficulty", "easy"]
    assert parser.parse_args(arguments).log_level == "INFO"
    assert parser.parse_args(arguments + ["--log-level", "DEBUG"]).log_level == "DEBUG"


def test_console_logs_go_to_stderr_without_duplicate_handlers(capsys):
    import logging

    from mobile_world.core.subcommands.autonomous import _configure_logging

    logger = logging.getLogger("mobile_world.autonomous")
    saved = (logger.level, logger.propagate, list(logger.handlers))
    logger.handlers = []
    try:
        _configure_logging("INFO")
        _configure_logging("INFO")
        logger.info("Sending model request")
        logger.debug("private preview")
        output = capsys.readouterr()
        assert output.out == ""
        assert output.err.count("Sending model request") == 1
        assert "private preview" not in output.err
    finally:
        for handler in logger.handlers:
            handler.close()
        logger.setLevel(saved[0])
        logger.propagate = saved[1]
        logger.handlers = saved[2]


def test_autonomous_display_selection_defaults_to_secondary():
    import pytest

    parser = create_parser()
    args = ["autonomous", "--game", "maze_paint", "--difficulty", "easy"]
    assert parser.parse_args(args).windowed is False
    assert parser.parse_args(args + ["--windowed"]).windowed is True
    assert parser.parse_args(args).display == "secondary"
    assert parser.parse_args(args + ["--display", "primary"]).display == "primary"
    assert parser.parse_args(args + ["--display", "2"]).display == 2
    with pytest.raises(SystemExit):
        parser.parse_args(args + ["--display", "0"])


def test_explicit_single_level_remains_available_for_debugging():
    args = create_parser().parse_args(
        [
            "autonomous",
            "--game",
            "maze_paint",
            "--difficulty",
            "easy",
            "--level",
            "2",
        ]
    )
    assert args.level == 2
