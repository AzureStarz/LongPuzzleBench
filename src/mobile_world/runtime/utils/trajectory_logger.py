import json
import os
from datetime import UTC, datetime
from hashlib import sha256

from loguru import logger
from PIL import Image, ImageDraw

from mobile_world.runtime.utils.models import Observation


def save_screenshot(screenshot, path) -> None:
    screenshot.save(path)
    logger.info(f"Screenshot saved in {path}")


def decoded_screenshot_sha256(screenshot: Image.Image) -> str:
    """Hash decoded pixels rather than encoder-specific PNG bytes."""

    image = screenshot.convert("RGB")
    digest = sha256()
    digest.update(f"{image.width}x{image.height}:RGB".encode())
    digest.update(image.tobytes())
    return digest.hexdigest()


def extract_click_coordinates(action):
    x = action.get("x")
    y = action.get("y")
    action_corr = (x, y)
    return action_corr


def extract_drag_coordinates(action):
    start_x = action.get("start_x")
    start_y = action.get("start_y")
    end_x = action.get("end_x")
    end_y = action.get("end_y")
    return (start_x, start_y, end_x, end_y)


# Function to draw points on an image
def draw_clicks_on_image(image_path, output_path, click_coords):
    image = Image.open(image_path)
    draw = ImageDraw.Draw(image)

    # Draw each click coordinate as a red circle
    (x, y) = click_coords
    radius = 20
    if x and y:  # if get the coordinate, draw a circle
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill="red", outline="red")

    # Save the modified image
    save_screenshot(image, output_path)


# Function to draw a drag line on an image
def draw_drag_on_image(image_path, output_path, drag_coords):
    image = Image.open(image_path)
    draw = ImageDraw.Draw(image)

    (start_x, start_y, end_x, end_y) = drag_coords
    if start_x and start_y and end_x and end_y:
        # Draw a line from start to end
        draw.line((start_x, start_y, end_x, end_y), fill="blue", width=5)
        # Draw circles at start (green) and end (red) points
        radius = 15
        draw.ellipse(
            (start_x - radius, start_y - radius, start_x + radius, start_y + radius),
            fill="green",
            outline="green",
        )
        draw.ellipse(
            (end_x - radius, end_y - radius, end_x + radius, end_y + radius),
            fill="red",
            outline="red",
        )

    # Save the modified image
    save_screenshot(image, output_path)


LOG_FILE_NAME = "traj.json"
SCORE_FILE_NAME = "result.txt"


class TrajLogger:
    def __init__(self, log_file_root: str, task_name: str):
        self.log_file_dir = os.path.join(log_file_root, task_name)
        self.log_file_name = LOG_FILE_NAME
        self.score_file_name = SCORE_FILE_NAME
        self.screenshots_dir = "screenshots"
        self.marked_screenshots_dir = "marked_screenshots"
        self.post_screenshots_dir = "post_screenshots"
        self.tools: list[dict] | None = None

        if os.path.exists(self.log_file_dir) and os.path.exists(
            os.path.join(self.log_file_dir, self.screenshots_dir)
        ):
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_dir = f"{self.log_file_dir}_backup_{timestamp}"

            # Rename existing folder to backup
            os.rename(self.log_file_dir, backup_dir)
            logger.info(f"Existing folder renamed to: {backup_dir}")

        os.makedirs(self.log_file_dir, exist_ok=True)
        os.makedirs(os.path.join(self.log_file_dir, self.screenshots_dir), exist_ok=True)
        os.makedirs(os.path.join(self.log_file_dir, self.marked_screenshots_dir), exist_ok=True)
        os.makedirs(os.path.join(self.log_file_dir, self.post_screenshots_dir), exist_ok=True)
        with open(os.path.join(self.log_file_dir, self.log_file_name), "w") as f:
            json.dump({}, f)

    def log_traj(
        self,
        task_name: str,
        task_goal: str,
        step: int,
        prediction: str,
        action: dict,
        obs: Observation,
        token_usage: dict[str, int] | None = None,
        parsed_action: dict | None = None,
        normalized_action: dict | None = None,
        parser_diagnostics: list[dict] | None = None,
        model_usage: dict | None = None,
    ) -> None:
        task_id = "0"

        with open(os.path.join(self.log_file_dir, self.log_file_name)) as f:
            log_data = json.load(f)

        if task_id not in log_data:
            log_data[task_id] = {"tools": self.tools, "traj": []}

        screenshot_name = f"{task_name}-{task_id}-{step}.png"
        original_screenshot_path = os.path.join(
            self.log_file_dir, self.screenshots_dir, screenshot_name
        )
        pre_observation = {
            "frame_id": obs.frame_id,
            "screenshot_path": os.path.join(self.screenshots_dir, screenshot_name),
            "screenshot_sha256": decoded_screenshot_sha256(obs.screenshot),
            "captured_at": datetime.now(UTC).isoformat(),
        }
        pre_action_feedback = (
            obs.action_feedback.model_dump() if obs.action_feedback is not None else None
        )
        log_data[task_id]["traj"].append(
            {
                "task_goal": task_goal,
                "step": step,
                "prediction": prediction,
                "action": action,
                "raw_model_response": prediction,
                "parsed_action": parsed_action if parsed_action is not None else action,
                "normalized_action": (
                    normalized_action if normalized_action is not None else action
                ),
                "parser_diagnostics": parser_diagnostics,
                "model_usage": model_usage,
                "pre_observation": pre_observation,
                "ask_user_response": obs.ask_user_response,
                "tool_call": obs.tool_call,
                # Keep the explicit pre/post fields so history feedback cannot be
                # confused with the result of the action logged on this step.
                "pre_action_feedback": pre_action_feedback,
                "public_action_feedback": pre_action_feedback,
            }
        )
        log_data[task_id]["token_usage"] = token_usage

        with open(os.path.join(self.log_file_dir, self.log_file_name), "w") as f:
            json.dump(log_data, f, ensure_ascii=False, indent=4)

        save_screenshot(obs.screenshot, original_screenshot_path)

        action_type = action.get("action_type")
        if action_type in ["click", "double_tap", "long_press"]:
            click_coordinates = extract_click_coordinates(action)
            marked_screenshot_path = os.path.join(
                self.log_file_dir,
                self.marked_screenshots_dir,
                f"marked-{task_name}-{task_id}-{step}.png",
            )
            draw_clicks_on_image(
                original_screenshot_path, marked_screenshot_path, click_coordinates
            )
        elif action_type == "drag":
            drag_coordinates = extract_drag_coordinates(action)
            marked_screenshot_path = os.path.join(
                self.log_file_dir,
                self.marked_screenshots_dir,
                f"marked-{task_name}-{task_id}-{step}.png",
            )
            draw_drag_on_image(original_screenshot_path, marked_screenshot_path, drag_coordinates)

    def log_metadata(self, metadata: dict) -> None:
        """Persist model/harness/environment identity with the trajectory."""

        task_id = "0"
        trajectory_path = os.path.join(self.log_file_dir, self.log_file_name)
        with open(trajectory_path) as file:
            log_data = json.load(file)
        task_data = log_data.setdefault(
            task_id,
            {"tools": self.tools, "traj": []},
        )
        task_data["metadata"] = metadata
        with open(trajectory_path, "w") as file:
            json.dump(log_data, file, ensure_ascii=False, indent=4)

    def log_action_result(
        self,
        task_name: str,
        step: int,
        *,
        executed_action: dict | None,
        execution_result: dict,
        post_observation: Observation | None,
        duration_seconds: float,
        error: str | None = None,
    ) -> None:
        """Attach the true dispatch result and aligned post-action frame."""

        task_id = "0"
        trajectory_path = os.path.join(self.log_file_dir, self.log_file_name)
        with open(trajectory_path) as file:
            log_data = json.load(file)
        items = log_data.get(task_id, {}).get("traj", [])
        matching = [item for item in items if item.get("step") == step]
        if not matching:
            raise RuntimeError(f"Trajectory step {step} was not logged before its result")
        item = matching[-1]
        item["executed_action"] = executed_action
        item["execution_result"] = execution_result
        item["action_id"] = execution_result.get("action_id")
        post_action_feedback = execution_result.get(
            "public_feedback",
            (
                post_observation.action_feedback.model_dump()
                if post_observation is not None and post_observation.action_feedback is not None
                else None
            ),
        )
        item["post_action_feedback"] = post_action_feedback
        # Backward-compatible field used by existing trajectory viewers.
        item["public_action_feedback"] = post_action_feedback
        item["execution_duration_seconds"] = max(0.0, float(duration_seconds))
        item["action_completed_at"] = datetime.now(UTC).isoformat()
        if error is not None:
            item["error"] = error

        if post_observation is not None:
            screenshot_name = f"{task_name}-{task_id}-{step}.png"
            relative_path = os.path.join(self.post_screenshots_dir, screenshot_name)
            screenshot_path = os.path.join(self.log_file_dir, relative_path)
            save_screenshot(post_observation.screenshot, screenshot_path)
            item["post_observation"] = {
                "frame_id": post_observation.frame_id,
                "screenshot_path": relative_path,
                "screenshot_sha256": decoded_screenshot_sha256(post_observation.screenshot),
                "captured_at": datetime.now(UTC).isoformat(),
            }

        with open(trajectory_path, "w") as file:
            json.dump(log_data, file, ensure_ascii=False, indent=4)

    def log_tools(self, tools: list[dict]):
        self.tools = tools

    def log_score(self, score: float, reason: str = "Unknown reason"):
        with open(os.path.join(self.log_file_dir, self.score_file_name), "w") as f:
            f.write(f"score: {score}\nreason: {reason}")

        # reset tools after logging score
        self.tools = None

    def log_termination(
        self,
        reason: str | None,
        diagnostics: dict | None = None,
    ) -> None:
        """Persist final episode termination beside the step-aligned trajectory."""

        trajectory_path = os.path.join(self.log_file_dir, self.log_file_name)
        with open(trajectory_path) as file:
            log_data = json.load(file)
        termination = {
            "reason": reason,
            "diagnostics": diagnostics,
            "recorded_at": datetime.now(UTC).isoformat(),
        }
        log_data["termination"] = termination
        items = log_data.get("0", {}).get("traj", [])
        if items:
            items[-1]["termination_reason"] = reason
            if diagnostics is not None:
                items[-1]["termination_diagnostics"] = diagnostics
        with open(trajectory_path, "w") as file:
            json.dump(log_data, file, ensure_ascii=False, indent=4)

    def log_token_usage(self, token_usage: dict[str, int]) -> None:
        """Log token usage to traj.json."""
        with open(os.path.join(self.log_file_dir, self.log_file_name)) as f:
            log_data = json.load(f)

        log_data["token_usage"] = token_usage

        with open(os.path.join(self.log_file_dir, self.log_file_name), "w") as f:
            json.dump(log_data, f, ensure_ascii=False, indent=4)

    def reset_traj(self):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Backup screenshots dir
        screenshots_path = os.path.join(self.log_file_dir, self.screenshots_dir)
        if os.path.exists(screenshots_path):
            os.rename(screenshots_path, f"{screenshots_path}_backup_{timestamp}")

        # Backup marked_screenshots dir
        marked_path = os.path.join(self.log_file_dir, self.marked_screenshots_dir)
        if os.path.exists(marked_path):
            os.rename(marked_path, f"{marked_path}_backup_{timestamp}")

        post_path = os.path.join(self.log_file_dir, self.post_screenshots_dir)
        if os.path.exists(post_path):
            os.rename(post_path, f"{post_path}_backup_{timestamp}")

        # Backup traj.json
        traj_path = os.path.join(self.log_file_dir, self.log_file_name)
        if os.path.exists(traj_path):
            backup_traj_path = os.path.join(self.log_file_dir, f"traj_backup_{timestamp}.json")
            os.rename(traj_path, backup_traj_path)

        # Recreate directories and empty traj.json
        os.makedirs(screenshots_path, exist_ok=True)
        os.makedirs(marked_path, exist_ok=True)
        os.makedirs(post_path, exist_ok=True)
        with open(traj_path, "w") as f:
            json.dump({}, f)

        self.tools = None
        logger.info(f"Trajectory reset with backup timestamp: {timestamp}")
