"""Shared checkpoint and feature-version contract for training and live play."""

MODEL_CONTRACTS = {
    "entity-v6": {"state": 15, "action": 11, "stateSize": 2054, "actionSize": 448},
}

ENCODING_CONTRACTS = {
    (14, 9): {"state": 14, "action": 9, "stateSize": 1790, "actionSize": 256},
    (14, 10): {"state": 14, "action": 10, "stateSize": 1790, "actionSize": 256},
    (15, 11): MODEL_CONTRACTS["entity-v6"],
}


def encoding_contract(state_version, action_version):
    contract = (ENCODING_CONTRACTS.get((state_version, action_version))
                if type(state_version) is int and type(action_version) is int else None)
    if contract is None:
        raise ValueError(f"不支持的状态/动作编码组合：v{state_version}/v{action_version}；支持 v14/v9、v14/v10、v15/v11")
    return dict(contract)


def config_contract(config):
    return encoding_contract(config.get("stateEncodingVersion", 15), config.get("actionEncodingVersion", 11))


def checkpoint_resume_plan(checkpoint, state_version=15, action_version=11, profile=None):
    target = encoding_contract(state_version, action_version)
    source = validate_checkpoint_contract(checkpoint, "entity-v6")
    source_profile = (checkpoint.get("model") or {}).get("profile")
    if source_profile not in ("fast", "balanced", "large"):
        raise ValueError("checkpoint 缺少有效的网络规模 profile")
    if profile is not None and profile != source_profile:
        raise ValueError(f"网络规模不匹配：权重为 {source_profile}，目标为 {profile}；请从权重读取网络规模")
    if source == target:
        mode, message = "direct", "编码相同，直接加载权重；有优化器存档时一并恢复"
    elif source["state"] == 14 and target == ENCODING_CONTRACTS[(14, 10)] and source["action"] == 9:
        mode, message = "action-v9-v10", "自动迁移动作 v9→v10；新增输入权重置零，重置优化器"
    elif source["state"] == 14 and target["state"] == 15:
        mode, message = "district-v14-v15", "自动迁移至 v15/v11；保留旧建筑与网络参数，新增输入及建筑嵌入置零，重置优化器"
    else:
        raise ValueError(f"不支持编码降级：v{source['state']}/v{source['action']} → v{target['state']}/v{target['action']}")
    return {"supported": True, "mode": mode, "source": source, "target": target,
            "profile": source_profile, "resetOptimizer": mode != "direct", "message": message}


def encoding_compatible(state_version, action_version):
    return (type(state_version) is int and type(action_version) is int and
            (state_version, action_version) in ENCODING_CONTRACTS)


def validate_checkpoint_contract(checkpoint: dict, architecture: str) -> dict:
    if not isinstance(checkpoint, dict):
        raise ValueError("checkpoint 格式无效")
    expected = MODEL_CONTRACTS.get(architecture)
    if expected is None:
        raise ValueError(f"不支持的 checkpoint 网络架构：{architecture}")
    model = checkpoint.get("model") or {}
    encoding = checkpoint.get("encoding") or {}
    if not isinstance(model, dict) or not isinstance(encoding, dict):
        raise ValueError("checkpoint 模型或编码元数据格式无效")
    if model.get("architecture") != architecture:
        raise ValueError("checkpoint 网络架构与模型配置不一致")
    state_version = encoding.get("state")
    if state_version is None:
        state_version = model.get("encodingVersion")
    if state_version is None:
        raise ValueError("checkpoint 缺少明确的状态编码版本")
    if model.get("encodingVersion") is not None and model["encodingVersion"] != state_version:
        raise ValueError("checkpoint 的模型与编码元数据记录了不同的状态版本")
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
    contract = encoding_contract(state_version, action_version)
    for field, label in (("stateSize", "状态"), ("actionSize", "动作")):
        if model.get(field) != contract[field]:
            raise ValueError(f"checkpoint {label}宽度不兼容：{model.get(field)} != {contract[field]}")
    return dict(contract)
