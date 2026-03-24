"""Event type definitions - standardized event types for cross-module communication."""

from enum import Enum


class EventType(Enum):
    """Standard event types for cross-module communication."""

    # Workflow lifecycle events
    WORKFLOW_STARTED = "workflow.started"
    WORKFLOW_STATE_CHANGED = "workflow.state_changed"
    WORKFLOW_COMPLETED = "workflow.completed"
    WORKFLOW_FAILED = "workflow.failed"
    WORKFLOW_CANCELLED = "workflow.cancelled"

    # Task events
    TASK_CREATED = "task.created"
    TASK_STARTED = "task.started"
    TASK_COMPLETED = "task.completed"
    TASK_FAILED = "task.failed"
    TASK_CANCELLED = "task.cancelled"

    # Order events
    ORDER_PLACED = "order.placed"
    ORDER_VALIDATED = "order.validated"
    ORDER_PAYMENT_INITIATED = "order.payment_initiated"
    ORDER_PAYMENT_COMPLETED = "order.payment_completed"
    ORDER_PAYMENT_FAILED = "order.payment_failed"
    ORDER_FULFILLED = "order.fulfilled"
    ORDER_SHIPPED = "order.shipped"
    ORDER_DELIVERED = "order.delivered"

    # Agent events
    AGENT_CREATED = "agent.created"
    AGENT_TASK_ASSIGNED = "agent.task_assigned"
    AGENT_TASK_COMPLETED = "agent.task_completed"
    AGENT_MESSAGE_RECEIVED = "agent.message_received"
    AGENT_MESSAGE_SENT = "agent.message_sent"

    # Entity lifecycle events
    ENTITY_CREATED = "entity.created"
    ENTITY_UPDATED = "entity.updated"
    ENTITY_DELETED = "entity.deleted"

    # Query events (for request/response pattern)
    SCHEDULING_QUERY = "scheduling.query"
    SCHEDULING_QUERY_RESPONSE = "scheduling.query_response"

    # System events
    SYSTEM_STARTUP = "system.startup"
    SYSTEM_SHUTDOWN = "system.shutdown"
    HEALTH_CHECK = "health.check"

    # Custom events
    CUSTOM = "custom"
