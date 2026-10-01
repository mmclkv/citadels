"""Opt-in FRP client lifecycle management for the Python server."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


def _integer(env: dict[str, str], name: str, fallback: int = 0) -> int:
    try:
        value = float(env.get(name, str(fallback)))
        return int(value) if value.is_integer() else fallback
    except (TypeError, ValueError, OverflowError):
        return fallback


def build_config(port: int, env: dict[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    server_addr = (env.get("CITADELS_FRP_SERVER_ADDR") or "").strip()
    server_port = _integer(env, "CITADELS_FRP_SERVER_PORT", 7000)
    token = env.get("CITADELS_FRP_TOKEN") or ""
    proxy_type = (env.get("CITADELS_FRP_TYPE") or "http").strip().lower()
    local_port = _integer(env, "CITADELS_FRP_LOCAL_PORT", port)
    name = (env.get("CITADELS_FRP_NAME") or "citadels").strip() or "citadels"
    tls = env.get("CITADELS_FRP_TLS") != "0"
    if not server_addr:
        raise ValueError("未设置 CITADELS_FRP_SERVER_ADDR")
    if not token:
        raise ValueError("未设置 CITADELS_FRP_TOKEN")
    if not 1 <= server_port <= 65535:
        raise ValueError("CITADELS_FRP_SERVER_PORT 无效")
    if not 1 <= local_port <= 65535:
        raise ValueError("CITADELS_FRP_LOCAL_PORT 无效")
    if proxy_type not in ("http", "https", "tcp"):
        raise ValueError("CITADELS_FRP_TYPE 只能是 http、https 或 tcp")
    quote = lambda value: json.dumps(str(value), ensure_ascii=False)
    lines = [f"serverAddr = {quote(server_addr)}", f"serverPort = {server_port}",
             'auth.method = "token"', f"auth.token = {quote(token)}",
             "transport.tls.enable = " + ("true" if tls else "false"), "", "[[proxies]]",
             f"name = {quote(name)}", f"type = {quote(proxy_type)}", 'localIP = "127.0.0.1"',
             f"localPort = {local_port}"]
    if proxy_type == "tcp":
        remote_port = _integer(env, "CITADELS_FRP_REMOTE_PORT")
        if not 1 <= remote_port <= 65535:
            raise ValueError("TCP 穿透需要设置有效的 CITADELS_FRP_REMOTE_PORT")
        lines.append(f"remotePort = {remote_port}")
    else:
        domain = (env.get("CITADELS_FRP_DOMAIN") or "").strip()
        if not domain:
            raise ValueError("HTTP/HTTPS 穿透需要设置 CITADELS_FRP_DOMAIN")
        lines.append(f"customDomains = [{quote(domain)}]")
    return "\n".join(lines) + "\n"


class FrpManager:
    def __init__(self, port: int, root: str | Path, log, env: dict[str, str] | None = None):
        self.port = port
        self.root = Path(root)
        self.log = log
        self.env = os.environ if env is None else env
        self.process: asyncio.subprocess.Process | None = None
        self.generated_config = ""

    def status(self) -> dict:
        enabled = self.env.get("CITADELS_FRP_ENABLED") == "1"
        config_path = (self.env.get("CITADELS_FRP_CONFIG") or "").strip()
        configured = bool(config_path or (self.env.get("CITADELS_FRP_SERVER_ADDR") and
                                          self.env.get("CITADELS_FRP_TOKEN")))
        running = self.process is not None and self.process.returncode is None
        proxy_type = self.env.get("CITADELS_FRP_TYPE") or "http"
        return {"enabled": enabled, "configured": bool(enabled and configured), "running": running,
                "type": proxy_type, "domain": self.env.get("CITADELS_FRP_DOMAIN") or "",
                "remotePort": _integer(self.env, "CITADELS_FRP_REMOTE_PORT") or None}

    async def start(self) -> None:
        if self.env.get("CITADELS_FRP_ENABLED") != "1":
            self.log("[frp] 未启用（设置 CITADELS_FRP_ENABLED=1 后重启）")
            return
        if self.process and self.process.returncode is None:
            return
        requested = (self.env.get("CITADELS_FRPC_PATH") or
                     ("frpc.exe" if os.name == "nt" else "frpc"))
        executable = requested if Path(requested).is_file() else shutil.which(requested)
        if not executable:
            raise RuntimeError("未找到 frpc，请安装 FRP 或设置 CITADELS_FRPC_PATH")
        config_path = (self.env.get("CITADELS_FRP_CONFIG") or "").strip()
        if config_path:
            if not Path(config_path).is_file():
                raise RuntimeError("FRP 配置文件不存在：" + config_path)
            self.log("[frp] 使用外部配置：" + config_path)
        else:
            config = build_config(self.port, self.env)
            handle = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".toml",
                prefix="citadels-frpc-", delete=False)
            try:
                with handle:
                    handle.write(config)
                if os.name != "nt":
                    os.chmod(handle.name, 0o600)
            except Exception:
                Path(handle.name).unlink(missing_ok=True)
                raise
            config_path = handle.name
            self.generated_config = config_path
            target = ("TCP" if self.env.get("CITADELS_FRP_TYPE") == "tcp"
                      else self.env.get("CITADELS_FRP_DOMAIN") or "HTTP")
            self.log("[frp] 已生成临时配置，目标：" + target)
        self.log("[frp] 启动 frpc：" + str(executable))
        try:
            self.process = await asyncio.create_subprocess_exec(str(executable), "-c", config_path,
                cwd=str(self.root), env=dict(self.env), stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                **({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
                   if os.name == "nt" else {}))
        except OSError as exc:
            await self.close()
            raise RuntimeError("无法启动 frpc：" + str(exc)) from exc
        asyncio.create_task(self._read_output(self.process.stdout))
        asyncio.create_task(self._read_output(self.process.stderr))
        asyncio.create_task(self._watch(self.process))

    async def _read_output(self, stream) -> None:
        while stream:
            line = await stream.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").strip()
            if text:
                self.log("[frp] " + text[:1000])

    async def _watch(self, process) -> None:
        code = await process.wait()
        if self.process is process:
            self.log(f"[frp] frpc 已退出（code={code}）")
            self.process = None
            await self._remove_generated_config()

    async def close(self) -> None:
        process, self.process = self.process, None
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        await self._remove_generated_config()

    async def _remove_generated_config(self) -> None:
        if self.generated_config:
            Path(self.generated_config).unlink(missing_ok=True)
            self.generated_config = ""
