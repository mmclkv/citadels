"""Shared checkpoint and feature-version contract for training and live play."""

MODEL_CONTRACTS = {
    "entity-v6": {"state": 14, "action": 10, "stateSize": 1790, "actionSize": 256},
}


def encoding_compatible(state_version, action_version):
    return state_version == 14 and action_version in (9, 10)


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
    if state_version is None:
        raise ValueError("checkpoint 缺少明确的状态编码版本")
    action_version = encoding.get("action")
    if action_version is None:
        raise ValueError("checkpoint 缺少明确的动作编码版本")
    if not encoding_compatible(state_version, action_version):
        raise ValueError(
            "checkpoint 状态/动作编码版本不兼容："
            f"({state_version}, {action_version}) != "
            f"({expected['state']}, {expected['action']})")
    # Live inference MUST keep the encoding declared by this checkpoint.
    return {**expected, "action": action_version}
