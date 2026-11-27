"""Offline interoperability assertions using the independently released Python SDK."""

import asyncio
import importlib.metadata
import json
import os
import sys
from pathlib import Path

from acp import Agent, Client, connect_to_agent, run_agent
from acp.helpers import update_agent_message
from acp.schema import (
    AgentCapabilities,
    ClientCapabilities,
    ImageContentBlock,
    Implementation,
    InitializeResponse,
    LoadSessionResponse,
    NewSessionResponse,
    PermissionOption,
    PromptResponse,
    RequestPermissionResponse,
    TextContentBlock,
    ToolCallUpdate,
)

SDK_VERSION = "0.12.1"
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="


def record_process(kind, pid):
    journal = os.environ.get("OCTOCODE_ACP_FIXTURE_PIDS")
    if journal:
        with open(journal, "a", encoding="utf8") as output:
            output.write(json.dumps({"kind": kind, "pid": pid}) + "\n")


class Peer(Agent):
    def __init__(self):
        self.turns = {}

    def on_connect(self, connection):
        self.connection = connection

    async def initialize(self, protocol_version, **kwargs):
        return InitializeResponse(
            protocol_version=1,
            agent_info=Implementation(name="python-interop-fixture", version=SDK_VERSION),
            agent_capabilities=AgentCapabilities(load_session=True),
        )

    async def new_session(self, cwd, **kwargs):
        self.turns["python-session"] = 0
        return NewSessionResponse(session_id="python-session")

    async def load_session(self, cwd, session_id, **kwargs):
        assert session_id == "python-saved"
        self.turns[session_id] = 10
        return LoadSessionResponse()

    async def prompt(self, session_id, prompt, **kwargs):
        text = "".join(block.text for block in prompt if block.type == "text")
        self.turns[session_id] += 1
        if text == "permission":
            reply = await self.connection.request_permission(
                session_id=session_id,
                tool_call=ToolCallUpdate(tool_call_id="write-1", title="Fixture permission", kind="edit"),
                options=[
                    PermissionOption(option_id="allow", name="Allow once", kind="allow_once"),
                    PermissionOption(option_id="reject", name="Reject once", kind="reject_once"),
                ],
            )
            text = reply.outcome.model_dump_json(by_alias=True, exclude_none=True)
        for chunk in [f"turn {self.turns[session_id]}: ", text]:
            await self.connection.session_update(
                session_id=session_id,
                update=update_agent_message(TextContentBlock(type="text", text=chunk)),
            )
        if text == "wait":
            await asyncio.Event().wait()
        return PromptResponse(stop_reason="end_turn")

    async def cancel(self, session_id, **kwargs):
        pass  # The outbound owner also terminates the fixture process after cancellation.


class Observer(Client):
    def __init__(self):
        self.updates = []

    async def session_update(self, session_id, update, **kwargs):
        self.updates.append((session_id, update.model_dump(by_alias=True, exclude_none=True)))

    async def request_permission(self, **kwargs):
        return RequestPermissionResponse(outcome={"outcome": "cancelled"})

    def text(self, session_id):
        return "".join(
            update["content"]["text"]
            for sid, update in self.updates
            if sid == session_id
            and update["sessionUpdate"] == "agent_message_chunk"
            and update["content"]["type"] == "text"
        )


async def check_client(config):
    process = await asyncio.create_subprocess_exec(
        *config["command"], cwd=config["cwd"], env=config["env"],
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=sys.stderr,
    )
    record_process("broker", process.pid)
    observer = Observer()
    connection = connect_to_agent(observer, process.stdin, process.stdout)
    checks = []
    try:
        initialized = await connection.initialize(protocol_version=1, client_capabilities=ClientCapabilities())
        assert initialized.protocol_version == 1
        assert initialized.agent_capabilities.load_session
        checks.append("initialize/capabilities")
        first = await connection.new_session(cwd=config["cwd"], mcp_servers=[])
        sid = first.session_id
        text = "héllo 🐙\nsecond line"
        result = await connection.prompt(sid, [TextContentBlock(type="text", text=text)])
        assert result.stop_reason == "end_turn"
        assert observer.text(sid) == f"Fixture reply: {text}"
        checks.append("Unicode/newline round trip and ordered completion")
        await connection.prompt(sid, [
            TextContentBlock(type="text", text="remember image"),
            ImageContentBlock(type="image", data=PNG, mime_type="image/png"),
        ])
        observer.updates.clear()
        await connection.load_session(cwd=config["cwd"], session_id=sid, mcp_servers=[])
        assert any(update.get("content", {}).get("data") == PNG for _, update in observer.updates), observer.updates
        assert text in observer.text(sid)
        checks.append("same-connection load: text and image replay before response")
        observer.updates.clear()
        await connection.resume_session(session_id=sid, cwd=config["cwd"], mcp_servers=[])
        assert observer.updates == []
        listed = await connection.list_sessions(cwd=config["cwd"])
        assert sid in [item.session_id for item in listed.sessions]
        checks.append("resume without replay and session listing")
        second = await connection.new_session(cwd=config["cwd"], mcp_servers=[])
        replies = await asyncio.gather(*[
            connection.prompt(item, [TextContentBlock(type="text", text=item)])
            for item in [sid, second.session_id]
        ])
        assert all(reply.stop_reason == "end_turn" for reply in replies)
        assert observer.text(sid) == f"Fixture reply: {sid}"
        assert observer.text(second.session_id) == f"Fixture reply: {second.session_id}"
        checks.append("concurrent session isolation")
        pending = asyncio.create_task(connection.prompt(sid, [TextContentBlock(type="text", text="cancel")]))
        await asyncio.sleep(0.1)
        assert not pending.done()
        await connection.cancel(sid)
        assert (await pending).stop_reason == "cancelled"
        assert (await connection.prompt(sid, [TextContentBlock(type="text", text="after cancel")])).stop_reason == "end_turn"
        checks.append("cancellation and subsequent prompt")
        await connection.close_session(sid)
        await connection.close_session(second.session_id)
        checks.append("close both sessions")
    except Exception:
        print(json.dumps({"completedChecks": checks}), file=sys.stderr)
        raise
    finally:
        await connection.close()
        process.stdin.close()
        await process.stdin.wait_closed()
        await asyncio.wait_for(process.wait(), timeout=15)
    assert process.returncode == 0
    return {
        "sdk": SDK_VERSION, "python": sys.version.split()[0],
        "pydantic": importlib.metadata.version("pydantic"),
        "checks": checks, "brokerExit": process.returncode,
    }


if __name__ == "__main__":
    isolated_run = os.environ.get("OCTOCODE_ACP_FIXTURE_RUN")
    assert isolated_run and os.environ.get("HOME") == isolated_run
    assert os.environ.get("OCTOCODE_HOME") == str(Path(isolated_run) / "home")
    assert "OCTOCODE_ACP_PARENT_ONLY" not in os.environ
    actual = importlib.metadata.version("agent-client-protocol")
    if actual != SDK_VERSION:
        raise RuntimeError(f"Expected agent-client-protocol=={SDK_VERSION}; found {actual}")
    if len(sys.argv) == 3 and sys.argv[1] == "agent":
        Path(sys.argv[2]).write_text(str(os.getpid()))
        record_process("peer", os.getpid())
        asyncio.run(run_agent(Peer()))
    elif len(sys.argv) == 3 and sys.argv[1] == "client":
        config = json.loads(Path(sys.argv[2]).read_text())
        print(json.dumps(asyncio.run(asyncio.wait_for(check_client(config), timeout=90))))
    else:
        raise RuntimeError("Expected agent <pid-file> or client <isolated-launch.json>")
