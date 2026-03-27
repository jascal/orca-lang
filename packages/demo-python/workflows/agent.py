"""Agent Task Supervisor - Demonstrates multi-agent orchestration with event bus."""

import asyncio
import re
from pathlib import Path
from typing import Dict, Any, List, Optional

from bus import DomainEvent, EventType, get_event_bus
from bus.decorators import on_event
from orca import parse_orca, OrcaMachine
from orca.types import Context, Event as OrcaEvent


def _load_orca_from_markdown(machine_name: str) -> str:
    """Extract an Orca machine definition from workflows.orca.md."""
    workflows_file = Path(__file__).parent.parent / "workflows.orca.md"
    content = workflows_file.read_text()

    # Find the section for this machine
    pattern = rf"## {machine_name}\n(.*?)```orca\n(.*?)\n```"
    match = re.search(pattern, content, re.DOTALL)
    if match:
        return match.group(2)
    raise ValueError(f"Machine '{machine_name}' not found in workflows.orca.md")


# Load Orca machine definition from markdown
AGENT_SUPERVISOR_ORCA = _load_orca_from_markdown("AgentSupervisor")


def create_agent_supervisor() -> OrcaMachine:
    """Create an agent supervisor state machine."""
    definition = parse_orca(AGENT_SUPERVISOR_ORCA)

    def assign_task(ctx: Context, event: OrcaEvent):
        ctx.set("task_id", event.data.get("task_id", ""))
        ctx.set("agent_id", event.data.get("agent_id", ""))
        ctx.set("subtasks", event.data.get("subtasks", []))
        ctx.set("completed_subtasks", [])
        ctx.set("status", "working")
        print(f"[AgentSupervisor] Task {ctx.get('task_id')} assigned to agent {ctx.get('agent_id')}")

    def complete_subtask(ctx: Context, event: OrcaEvent):
        subtask_id = event.data.get("subtask_id", "")
        completed = ctx.get("completed_subtasks", [])
        completed.append(subtask_id)
        ctx.set("completed_subtasks", completed)

        all_subtasks = ctx.get("subtasks", [])
        if len(completed) >= len(all_subtasks):
            print(f"[AgentSupervisor] All subtasks complete!")
        else:
            print(f"[AgentSupervisor] Subtask {subtask_id} complete ({len(completed)}/{len(all_subtasks)})")

    handlers = {
        "assign_task": assign_task,
        "complete_subtask": complete_subtask,
    }

    return OrcaMachine(definition, event_handlers=handlers)


class Agent:
    """Simple agent that processes tasks."""

    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self.tasks: List[str] = []

    async def process_task(self, task_data: Dict[str, Any], event_bus) -> Dict[str, Any]:
        """Process a task and publish events."""
        task_id = task_data.get("task_id")
        subtasks = task_data.get("subtasks", [])

        print(f"[Agent:{self.agent_id}] Processing task {task_id} with {len(subtasks)} subtasks")

        # Publish task assigned event
        await event_bus.publish(DomainEvent(
            event_type=EventType.AGENT_TASK_ASSIGNED,
            entity_id=task_id,
            entity_type="task",
            data={"agent_id": self.agent_id, "task_id": task_id},
            source_module="agent_demo"
        ))

        # Process each subtask
        for subtask in subtasks:
            await asyncio.sleep(0.05)
            print(f"[Agent:{self.agent_id}] Completed subtask: {subtask}")

            await event_bus.publish(DomainEvent(
                event_type=EventType.TASK_COMPLETED,
                entity_id=subtask,
                entity_type="subtask",
                data={"task_id": task_id, "agent_id": self.agent_id, "result": f"Result of {subtask}"},
                source_module="agent_demo"
            ))

        # Publish task completed
        await event_bus.publish(DomainEvent(
            event_type=EventType.AGENT_TASK_COMPLETED,
            entity_id=task_id,
            entity_type="task",
            data={"agent_id": self.agent_id, "result": "All subtasks completed"},
            source_module="agent_demo"
        ))

        return {"task_id": task_id, "status": "completed", "agent_id": self.agent_id}


async def run_agent_demo():
    """Run the agent task demo."""
    event_bus = get_event_bus()

    # Create agents
    agents = [
        Agent("agent-1"),
        Agent("agent-2"),
    ]

    # Create tasks
    tasks = [
        {
            "task_id": "task-1",
            "subtasks": ["fetch-data", "process-data", "save-results"]
        },
        {
            "task_id": "task-2",
            "subtasks": ["validate-input", "transform-data"]
        },
    ]

    print("\n" + "=" * 60)
    print("AGENT TASK SUPERVISOR DEMO")
    print("=" * 60 + "\n")

    # Run tasks concurrently
    results = await asyncio.gather(*[
        agent.process_task(task, event_bus)
        for agent, task in zip(agents, tasks)
    ])

    print("\n" + "-" * 60)
    print("Results:")
    for result in results:
        print(f"  {result}")

    # Show event history
    print("\n" + "-" * 60)
    print(f"Event history ({len(event_bus.event_store)} events):")
    for event in event_bus.event_store:
        print(f"  {event.event_type.value}: {event.entity_type}:{event.entity_id}")

    return results
