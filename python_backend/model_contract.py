"""Shared checkpoint and feature-version contract for training and live play."""

MODEL_CONTRACTS = {
    "flat": {"state": 8, "action": 8, "stateSize": 672, "actionSize": 256},
    "entity-v1": {"state": 8, "action": 8, "stateSize": 672, "actionSize": 256},
    "entity-v2": {"state": 8, "action": 8, "stateSize": 672, "actionSize": 256},
    "entity-v3": {"state": 9, "action": 8, "stateSize": 702, "actionSize": 256},
    "entity-v4": {"state": 10, "action": 8, "stateSize": 766, "actionSize": 256},
    "entity-v5": {"state": 11, "action": 8, "stateSize": 838, "actionSize": 256},
    "entity-v6": {"state": 12, "action": 9, "stateSize": 1790, "actionSize": 256},
}


def validate_checkpoint_contract(checkpoint: dict, architecture: str) -> dict:
    expected = MODEL_CONTRACTS.get(architecture)
    if expected is None:
        raise ValueError(f"不支持的 checkpoint 网络架构：{architecture}")
    model = checkpoint.get("model") or {}
    encoding = checkpoint.get("encoding") or {}
    if model.get("architecture") != architecture:
        raise ValueError("checkpoint 网络架构与模型配置不一致")
    if model.get("stateSize") != expected["stateSize"]:
        raise ValueError(
            f"checkpoint 状态宽度不兼容：{model.get('stateSize')} != {expected['stateSize']}")
    if model.get("actionSize") != expected["actionSize"]:
        raise ValueError(
            f"checkpoint 动作宽度不兼容：{model.get('actionSize')} != {expected['actionSize']}")
    state_version = encoding.get("state")
    if state_version is None:
        state_version = model.get("encodingVersion")
    # Early packaged checkpoints omitted explicit version fields. Their
    # architecture and exact feature widths still identify the legacy schema.
    if state_version is None:
        state_version = expected["state"]
    action_version = encoding.get("action")
    if action_version is None:
        action_version = expected["action"]
    if (state_version, action_version) != (expected["state"], expected["action"]):
        raise ValueError(
            "checkpoint 状态/动作编码版本不兼容："
            f"({state_version}, {action_version}) != "
            f"({expected['state']}, {expected['action']})")
    return expected
