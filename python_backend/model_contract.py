"""Shared checkpoint and feature-version contract for training and live play."""

MODEL_CONTRACTS = {
    "entity-v6": {"state": 15, "action": 11, "stateSize": 2054, "actionSize": 448},
}


def encoding_compatible(state_version, action_version):
    return (state_version == 14 and action_version in (9, 10) or
            state_version == 15 and action_version == 11)


def validate_checkpoint_contract(checkpoint: dict, architecture: str) -> dict:
    expected = MODEL_CONTRACTS.get(architecture)
    if expected is None:
        raise ValueError(f"不支持的 checkpoint 网络架构：{architecture}")
    model = checkpoint.get("model") or {}
    encoding = checkpoint.get("encoding") or {}
    if model.get("architecture") != architecture:
        raise ValueError("checkpoint 网络架构与模型配置不一致")
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
    # Old models use an explicit legacy layout; dimensions alone do not grant
    # compatibility with the expanded district encoding.
    contract = (expected if state_version == 15 else
                {"state": 14, "action": action_version, "stateSize": 1790, "actionSize": 256})
    for field, label in (("stateSize", "状态"), ("actionSize", "动作")):
        if model.get(field) != contract[field]:
            raise ValueError(f"checkpoint {label}宽度不兼容：{model.get(field)} != {contract[field]}")
    return dict(contract)
